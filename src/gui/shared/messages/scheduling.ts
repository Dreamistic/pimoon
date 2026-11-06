import type { ExecutionScheduling, ScheduledGroup, ScheduledOperation } from "../../../pimoon/scheduling.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function operationState(value: unknown): value is ScheduledOperation["state"] { return value === "queued" || value === "running" || value === "ok" || value === "error" || value === "skipped" || value === "interrupted"; }
function groupState(value: unknown): value is ScheduledGroup["state"] { return value === "running" || value === "completed" || value === "failed" || value === "interrupted"; }

/** 历史与扩展 details 是不可信边界；缺失/无效记录不凭源码猜测。 */
export function executionScheduling(details: unknown): ExecutionScheduling | undefined {
 if (!record(details) || !record(details.scheduling)) return;
 const value = details.scheduling;
 if (value.version !== 1 || typeof value.truncated !== "boolean" || !Array.isArray(value.groups) || value.groups.length > 32
  || (value.state !== "running" && value.state !== "completed" && value.state !== "interrupted")) return;
 const groups: ScheduledGroup[] = [];
 let count = 0;
 const ids = new Set<number>();
 for (const group of value.groups) {
  if (!record(group) || !number(group.id) || !Number.isInteger(group.id) || group.id < 1 || ids.has(group.id)
   || !number(group.total) || !Number.isInteger(group.total) || group.total > 256 || !groupState(group.state)
   || (group.policy !== "raise" && group.policy !== "collect") || !number(group.elapsedMs) || !number(group.peak) || !Number.isInteger(group.peak) || group.peak > group.total
   || !Array.isArray(group.operations) || group.operations.length > group.total || (group.overlapMs !== undefined && !number(group.overlapMs))) return;
  ids.add(group.id); count += group.operations.length; if (count > 256) return;
  const operations: ScheduledOperation[] = [];
  for (const operation of group.operations) {
   if (!record(operation) || operation.index !== operations.length || typeof operation.name !== "string" || operation.name.length > 64
    || typeof operation.target !== "string" || operation.target.length > 160 || !operationState(operation.state)
    || (operation.startMs !== undefined && !number(operation.startMs)) || (operation.durationMs !== undefined && !number(operation.durationMs))) return;
   operations.push({ index: operations.length, name: operation.name, target: operation.target, state: operation.state,
    ...(operation.startMs === undefined ? {} : { startMs: operation.startMs }), ...(operation.durationMs === undefined ? {} : { durationMs: operation.durationMs }) });
  }
  groups.push({ id: group.id, policy: group.policy, total: group.total, state: group.state, elapsedMs: group.elapsedMs, peak: group.peak, operations,
   ...(group.overlapMs === undefined ? {} : { overlapMs: group.overlapMs }) });
 }
 return { version: 1, state: value.state, truncated: value.truncated, groups };
}

/** 以本次单项耗时之和估算串行基线，不代表真实串行对照。 */
export function estimatedSchedulingSavings(value: ExecutionScheduling): number | undefined {
 if (value.state !== "completed" || value.truncated || !value.groups.length) return;
 let durations = 0, elapsed = 0;
 for (const group of value.groups) {
  if (group.state !== "completed" || group.operations.length !== group.total) return;
  elapsed += group.elapsedMs;
  for (const operation of group.operations) {
   if (operation.state !== "ok" || operation.durationMs === undefined) return;
   durations += operation.durationMs;
  }
 }
 return Number.isFinite(durations) && Number.isFinite(elapsed) ? Math.max(0, durations - elapsed) : undefined;
}
