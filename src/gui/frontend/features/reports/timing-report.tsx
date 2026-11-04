import type { LiveTelemetryReport } from "../../../../harness/telemetry-report/live.ts";
import type { NumericSummary } from "../../../../harness/telemetry-report/types.ts";
import type { SearchTimingStage } from "../../../../harness/telemetry-report/analyzers/timing.ts";
import { duration, Empty, Facts, number, Section } from "./shared.tsx";

const labels: Record<SearchTimingStage, string> = {
	inventory_ms: "目录发现", scan_ms: "文本扫描", analysis_ms: "语义分析与剩余预热等待",
	regionize_ms: "语法区域", rank_pack_ms: "排序与打包", search_total_ms: "搜索流水线总耗时",
};
const timingText = (value: NumericSummary) => value.samples === 0 ? "暂无数据"
	: `P50 ${duration(value.p50)} · P95 ${duration(value.p95)} · ${number(value.samples)} 个样本`;

export function TimingReport({ value }: { value: LiveTelemetryReport["timing"] }) {
	if (!value) return null;
	const search = value.search.filter(row => row.samples > 0);
	return <Section title="耗时拆分">
		{value.tools.length === 0 && search.length === 0 ? <Empty>尚无分阶段计时；历史缺失值不补零。</Empty> : <>
			{value.tools.map(tool => <Facts key={tool.tool} items={[
				[`${tool.tool} · 调用总耗时`, timingText(tool.wall_ms)],
				...(tool.approval_wait_ms.samples > 0 ? [[`${tool.tool} · 等待审批`, timingText(tool.approval_wait_ms)]] satisfies [string, string][] : []),
				...(tool.process_duration_ms.samples > 0 ? [[`${tool.tool} · 程序实际执行`, timingText(tool.process_duration_ms)]] satisfies [string, string][] : []),
				...(tool.incomplete_approvals > 0 ? [[`${tool.tool} · 审批计时未完整结束`, `${number(tool.incomplete_approvals)} 次`]] satisfies [string, string][] : []),
			]} />)}
			{search.length > 0 && <Facts items={search.map(row => [`grep · ${labels[row.stage]}`, timingText(row)])} />}
		</>}
		<p className="report-note">审批等待属于调用总耗时；SDK 执行也可能包含审批，不相加。程序耗时包含启动与退出清理。搜索阶段按顺序计时，预热与扫描重叠部分不重复计算。并行子调用不相加为整轮耗时。</p>
	</Section>;
}
