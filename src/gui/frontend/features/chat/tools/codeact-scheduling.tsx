import { GitFork } from "lucide-react";
import type { ExecutionScheduling, ScheduledGroup, ScheduledOperation } from "../../../../../pimoon/scheduling.ts";
import { executionScheduling } from "../../../../shared/messages/scheduling.ts";
import { outputPreview } from "../../../../shared/messages/output.ts";
import type { GuiToolOutput } from "../../../../shared/messages/types.ts";
import { Disclosure } from "@/ui/disclosure.tsx";
import { clean, record } from "@/ui/content/format.ts";
import { toolDisplay } from "./tool-display.tsx";

const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const states: Record<ScheduledOperation["state"], string> = { queued: "等待派发", running: "执行中", ok: "完成", error: "失败", skipped: "未启动", interrupted: "已中断" };
const groupStates: Record<ScheduledGroup["state"], string> = { running: "执行中", completed: "完成", failed: "有失败", interrupted: "已中断" };

export function schedulingView(output: GuiToolOutput | undefined): ExecutionScheduling | undefined {
 return executionScheduling(outputPreview(output)?.details);
}

export function SchedulingBadge({ output }: { output: GuiToolOutput | undefined }) {
 const value = schedulingView(output);
 if (value) {
  const peak = Math.max(0, ...value.groups.map(group => group.peak));
  if (!value.groups.length) return value.state === "completed" ? <span className="scheduling-badge" data-mode="serial">未使用并发组</span> : null;
  return <span className="scheduling-badge" data-mode={peak > 1 ? "parallel" : "group"}>
   <GitFork aria-hidden="true" />{peak > 1 ? `已并发 · 峰值 ${peak}` : "显式并发组"} · {value.groups.length}{value.truncated ? "+" : ""} 组
  </span>;
 }
 const details = outputPreview(output)?.details;
 const metrics = record(details) && record(details.metrics) ? details.metrics : undefined;
 const peak = metrics?.batch_peak_concurrency;
 return typeof peak === "number" && Number.isFinite(peak) && peak > 1
  ? <span className="scheduling-badge" data-mode="parallel" title="旧记录仅有汇总，没有逐项时间线"><GitFork aria-hidden="true" />已并发 · 峰值 {peak} · 仅汇总</span> : null;
}

export function SchedulingPanel({ value }: { value: ExecutionScheduling }) {
 if (!value.groups.length) return null;
 return <section className="scheduling-panel" aria-label="并发执行详情">
  <div className="scheduling-heading"><GitFork aria-hidden="true" /><strong>并发执行</strong><span>由模型显式选择</span></div>
  {value.groups.map(group => <SchedulingGroup key={group.id} group={group} />)}
  {value.truncated && <p className="tool-note">记录达到展示上限，部分组或操作未保留；不代表未执行。</p>}
  <p className="scheduling-note">重叠时长 = 各操作耗时之和 − 执行区间并集，可能包含审批等待；不是相对串行的实测提速。</p>
 </section>;
}

function SchedulingGroup({ group }: { group: ScheduledGroup }) {
 const overlap = group.overlapMs === undefined ? "重叠时长未完整记录" : `重叠 ${duration(group.overlapMs)}`;
 const status = groupStates[group.state];
 return <Disclosure className="scheduling-group" defaultOpen={group.state === "running"} summary={<span className="scheduling-group-title">
  <span>第 {group.id} 组 · {group.total} 项</span><span>{status} · 峰值 {group.peak}</span><span>{duration(group.elapsedMs)} · {overlap}</span>
 </span>}>
  <p className="scheduling-policy">{group.policy === "collect" ? "逐项收集失败，其他读取继续" : "失败后停止派发，已启动读取可能完成"}</p>
  <ol className="scheduling-operations">
   {group.operations.map(operation => <OperationRow key={operation.index} operation={operation} elapsedMs={group.elapsedMs} />)}
  </ol>
  {group.operations.length < group.total && <p className="tool-note">仅保留前 {group.operations.length} 项操作详情。</p>}
 </Disclosure>;
}

function OperationRow({ operation, elapsedMs }: { operation: ScheduledOperation; elapsedMs: number }) {
 const start = operation.startMs, span = Math.max(1, elapsedMs);
 const elapsed = operation.durationMs ?? (operation.state === "running" && start !== undefined ? Math.max(0, elapsedMs - start) : 0);
 const left = Math.min(100, (start ?? 0) / span * 100), width = Math.min(100 - left, elapsed / span * 100);
 return <li className="scheduling-operation" data-operation-state={operation.state}>
  <div className="scheduling-operation-heading"><span className="scheduling-operation-name">{operation.index + 1}. {operation.name === "native_read" ? "原文读取" : toolDisplay(operation.name).label}</span>
   <span>{states[operation.state]}{operation.durationMs !== undefined ? ` · ${duration(operation.durationMs)}` : ""}</span></div>
  {operation.target && <code className="scheduling-target">{clean(operation.target)}</code>}
  <div className="scheduling-track" aria-hidden="true">{start !== undefined && <span style={{ marginInlineStart: `${left}%`, inlineSize: `${width}%` }} />}</div>
 </li>;
}
