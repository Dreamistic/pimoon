import { GitFork } from "lucide-react";
import { executionScheduling } from "../../../../shared/messages/scheduling.ts";
import { outputPreview } from "../../../../shared/messages/output.ts";
import type { GuiToolOutput } from "../../../../shared/messages/types.ts";
import { record } from "@/ui/content/format.ts";

/** 并发是执行属性，沿用调用列表，不另建详情面板。 */
export function SchedulingBadge({ output }: { output: GuiToolOutput | undefined }) {
 const details = outputPreview(output)?.details;
 const value = executionScheduling(details);
 if (value) {
  if (!value.groups.length) return null;
  const peak = Math.max(0, ...value.groups.map(group => group.peak));
  return <span className="scheduling-badge" title="显式并发组；峰值是实际同时执行的操作数，不代表提速倍数">
   <GitFork aria-hidden="true" />{peak > 1 ? `并发 · 峰值 ${peak}` : "并发组"}
  </span>;
 }
 const metrics = record(details) && record(details.metrics) ? details.metrics : undefined;
 const peak = metrics?.batch_peak_concurrency;
 return typeof peak === "number" && Number.isFinite(peak) && peak > 1
  ? <span className="scheduling-badge" title="旧记录的实际并发峰值，不代表提速倍数"><GitFork aria-hidden="true" />并发 · 峰值 {peak}</span> : null;
}
