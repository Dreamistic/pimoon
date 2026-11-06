import { GitFork } from "lucide-react";
import { executionScheduling, estimatedSchedulingSavings } from "../../../../shared/messages/scheduling.ts";
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
  const saved = estimatedSchedulingSavings(value);
  const saving = saved === undefined || saved < 1 ? "" : saved < 1000 ? `约省 ${Math.round(saved)} ms` : `约省 ${Math.round(saved / 1000)} 秒`;
  return <span className="scheduling-badge" title="峰值不代表提速倍数；约省 = 单项耗时之和减去整组用时，是估算而非串行实测">
   <span className="scheduling-summary"><GitFork aria-hidden="true" />{peak > 1 ? `并发 · 峰值 ${peak}` : "并发组"}</span>{saving && <span className="scheduling-saving"> · {saving}</span>}
  </span>;
 }
 const metrics = record(details) && record(details.metrics) ? details.metrics : undefined;
 const peak = metrics?.batch_peak_concurrency;
 return typeof peak === "number" && Number.isFinite(peak) && peak > 1
  ? <span className="scheduling-badge" title="旧记录的实际并发峰值，不代表提速倍数"><GitFork aria-hidden="true" />并发 · 峰值 {peak}</span> : null;
}
