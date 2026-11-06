/** 执行元数据仅供本地界面，不加入模型正文或数值遥测。 */
export interface ScheduledOperation {
 index: number;
 name: string;
 target: string;
 state: "queued" | "running" | "ok" | "error" | "skipped" | "interrupted";
 startMs?: number;
 durationMs?: number;
}
export interface ScheduledGroup {
 id: number;
 policy: "raise" | "collect";
 total: number;
 state: "running" | "completed" | "failed" | "interrupted";
 elapsedMs: number;
 peak: number;
 overlapMs?: number;
 operations: ScheduledOperation[];
}
export interface ExecutionScheduling {
 version: 1;
 state: "running" | "completed" | "interrupted";
 truncated: boolean;
 groups: ScheduledGroup[];
}
interface Job { name: string; args: Record<string, unknown> }
interface GroupState { view: ScheduledGroup; started: number; active: number; intervals: Array<[number, number]>; operationStarts: Map<number, number> }
const MAX_GROUPS = 32, MAX_OPERATIONS = 256;
const round = (value: number) => Math.round(Math.max(0, value) * 10) / 10;

function target(args: Record<string, unknown>): string {
 const path = typeof args.path === "string" ? args.path : Array.isArray(args.path) ? args.path.filter((v): v is string => typeof v === "string").join(", ") : "";
 const query = typeof args.query === "string" ? args.query : "";
 // 进程只展示程序名；不把命令参数或环境变量复制进调度元数据。
 const program = Array.isArray(args.argv) && typeof args.argv[0] === "string" ? args.argv[0].split(/[\\/]/u).pop() : "";
 const value = [program, path, query].filter(Boolean).join(" · ").replace(/[\u0000-\u001f\u007f]/gu, " ");
 return value.length > 160 ? value.slice(0, 159) + "…" : value;
}

/** 不改变调度；在真实开始/结束边界采样，进度更新最多每 80ms 一次，组边界立即更新。 */
export class SchedulingTrace {
 private groups: GroupState[] = [];
 private count = 0;
 private operations = 0;
 private truncated = false;
 private state: ExecutionScheduling["state"] = "running";
 private lastUpdate = -Infinity;
 private timer: ReturnType<typeof setTimeout> | undefined;
 private readonly update: (value: ExecutionScheduling) => void;
 private readonly now: () => number;
 constructor(update: (value: ExecutionScheduling) => void = () => {}, now = () => performance.now()) { this.update = update; this.now = now; }

 begin(jobs: readonly Job[], policy: "raise" | "collect"): number {
  const id = ++this.count;
  if (this.groups.length >= MAX_GROUPS) { this.truncated = true; return id; }
  const selected = jobs.slice(0, Math.max(0, MAX_OPERATIONS - this.operations));
  this.operations += selected.length;
  this.truncated ||= selected.length < jobs.length;
  this.groups.push({ started: this.now(), active: 0, intervals: [], operationStarts: new Map(), view: {
   id, policy, total: jobs.length, state: "running", elapsedMs: 0, peak: 0,
   operations: selected.map((job, index) => ({ index, name: job.name === "process_run" ? "subprocess.run" : job.name, target: target(job.args), state: "queued" })),
  } });
  this.publish(true);
  return id;
 }
 observe(id: number, stage: "start" | "end", index: number, ok?: boolean): void {
  const group = this.groups.find(item => item.view.id === id);
  if (!group) return;
  const now = this.now(), offset = now - group.started, operation = group.view.operations[index];
  if (stage === "start") {
   group.active++; group.view.peak = Math.max(group.view.peak, group.active);
   group.operationStarts.set(index, offset);
   if (operation) { operation.state = "running"; operation.startMs = round(offset); }
  } else {
   group.active = Math.max(0, group.active - 1);
   const start = group.operationStarts.get(index);
   if (start !== undefined) { group.intervals.push([start, offset]); group.operationStarts.delete(index); }
   if (operation) { operation.state = ok ? "ok" : "error"; if (start !== undefined) operation.durationMs = round(offset - start); }
  }
  group.view.elapsedMs = round(offset);
  this.publish();
 }
 end(id: number, rows: readonly { ok: boolean; skipped?: boolean }[], interrupted = false): void {
  const group = this.groups.find(item => item.view.id === id);
  if (!group) return;
  group.view.elapsedMs = round(this.now() - group.started);
  group.view.state = interrupted ? "interrupted" : rows.some(row => !row.ok) ? "failed" : "completed";
  for (const operation of group.view.operations) {
   const row = rows[operation.index];
   if (row?.skipped) operation.state = "skipped";
   else if (operation.state === "running" || operation.state === "queued") operation.state = interrupted ? "interrupted" : "skipped";
  }
  if (!interrupted && group.operationStarts.size === 0) {
   let sum = 0, union = 0, right = -Infinity;
   for (const [start, end] of group.intervals.sort((a, b) => a[0] - b[0])) {
    sum += end - start; union += Math.max(0, end - Math.max(start, right)); right = Math.max(right, end);
   }
   group.view.overlapMs = round(sum - union);
  }
  this.publish(true);
 }
 finish(interrupted: boolean): ExecutionScheduling {
  this.state = interrupted ? "interrupted" : "completed";
  for (const group of this.groups) if (group.view.state === "running") {
   group.view.state = "interrupted"; group.view.elapsedMs = round(this.now() - group.started);
   for (const operation of group.view.operations) if (operation.state === "queued" || operation.state === "running") operation.state = "interrupted";
  }
  this.publish(true);
  return this.snapshot();
 }
 snapshot(): ExecutionScheduling {
  return { version: 1, state: this.state, truncated: this.truncated, groups: this.groups.map(group => ({ ...group.view, elapsedMs: group.view.state === "running" ? round(this.now() - group.started) : group.view.elapsedMs, operations: group.view.operations.map(operation => ({ ...operation })) })) };
 }
 private publish(force = false): void {
  const now = this.now();
  if (!force && now - this.lastUpdate < 80) {
   this.timer ??= setTimeout(() => { this.timer = undefined; this.publish(true); }, 80 - (now - this.lastUpdate));
   return;
  }
  clearTimeout(this.timer); this.timer = undefined;
  this.lastUpdate = now;
  try { this.update(this.snapshot()); } catch { /* 界面不可用不改变真实执行。 */ }
 }
}
