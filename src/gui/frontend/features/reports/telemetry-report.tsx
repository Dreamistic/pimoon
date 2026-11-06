import type { LiveTelemetryReport } from "../../../../harness/telemetry-report/live.ts";
import { TimingReport } from "./timing-report.tsx";
import { Bar, duration, Empty, Facts, Metrics, number, percent, ReportStamp, Section } from "./shared.tsx";
import { Disclosure } from "@/ui/disclosure.tsx";
import { ExecutionReport } from "./execution-report.tsx";
import { distribution, ratePercent, rateText } from "./telemetry-format.ts";

const workLabels: Record<string, string> = {
	size_bytes: "文件字节", total_candidate_count: "候选数", returned_file_count: "返回文件数", searched_file_count: "搜索文件数",
	searched_byte_count: "搜索字节", parsed_file_count: "解析文件数", text_hit_count: "文本命中数", returned_match_count: "返回区域数",
	input_edit_count: "替换规则数", replacement_count: "实际替换数", total_size_bytes: "命令输出字节", returned_size_bytes: "命令返回字节",
};

export function TelemetryReport({ value }: { value: LiveTelemetryReport }) {
	const { report } = value;
	const { execution } = report;
	const code = execution.codeact;
	const tools = report.tools.filter(tool => tool.tool !== "codeact").sort((a, b) => b.calls - a.calls);
	const maxCalls = Math.max(0, ...tools.map(tool => tool.calls));
	const hostSuccess = execution.host.calls - execution.host.error_rate.numerator;
	return <div className="report-dashboard">
		<div className="report-intro"><span className="report-badge" data-tone={value.enabled ? "success" : "warning"}>{value.enabled ? "采集已启用" : "采集已停用"}</span><h2>工具执行概览</h2><p>当前会话的 Python 执行、宿主工具和原生操作，按层统计。</p></div>
		<Metrics items={[
			{ label: "执行单元", value: number(code.calls) },
			{ label: "宿主调用", value: number(execution.host.calls) },
			{ label: "宿主成功率", value: percent(execution.host.calls > 0 ? hostSuccess / execution.host.calls * 100 : undefined), tone: execution.host.error_rate.numerator > 0 ? "warning" : "success" },
			{ label: "进行中调用", value: number(value.pending_calls) },
		]} />
		<ExecutionReport code={code} />
		<Section title="宿主工具对比">
			{tools.length === 0 ? <Empty>尚无已完成的宿主工具调用；纯 Python 执行不计入此处。</Empty> : <div className="report-bars">{tools.map(tool => {
				const layer = execution.by_tool[tool.tool];
				return <div className="report-tool" key={tool.tool}>
					<Bar label={tool.tool} value={maxCalls > 0 ? tool.calls / maxCalls * 100 : undefined} text={`${number(tool.calls)} 次`} hint={`成功率 ${percent(ratePercent(tool.success_rate))} · P50 ${duration(tool.duration_ms.p50)} · P95 ${duration(tool.duration_ms.p95)}`} tone={tool.error_rate.numerator > 0 ? "warning" : "accent"} />
					<Disclosure className="report-details" summary={`${tool.tool} 详细指标`}><Facts items={[
						["直接 / 内部调用", `${number(layer?.direct)} / ${number(layer?.nested)}`],
						["成功", rateText(tool.success_rate)], ["错误", rateText(tool.error_rate)], ["输出截断", rateText(tool.truncation_rate)],
						["耗时", distribution(tool.duration_ms, duration)], ["返回文本字符", distribution(tool.output_chars)],
						...Object.entries(tool.work).map(([key, summary]): [string, string] => [workLabels[key] ?? key, distribution(summary)]),
						...(tool.input_path_count.samples > 0 || tool.scope_count.samples > 0 ? [["多范围调用", number(tool.multi_scope_calls)], ["范围错误", number(tool.scope_errors)]] satisfies [string, string][] : []),
						...(tool.repair.observed_calls > 0 ? [["参数修复", rateText(tool.repair.repaired_rate)], ["分发调用", number(tool.repair.fanout_calls)]] satisfies [string, string][] : []),
						...Object.entries(tool.error_codes).map(([error, count]): [string, string] => [`错误 · ${error}`, number(count)]),
					]} /></Disclosure>
				</div>;
			})}</div>}
			<p className="report-note">内部搜索只统计执行工作量，不推断模型候选采用率。宿主错误不等于整个执行失败；内部错误可能被 Python 捕获。进行中调用包含父执行和子工具，不能视为任务数。</p>
		</Section>
		<Section title="采集详情" detail><Facts items={[
			["会话 ID", value.session_id ?? "未提供"], ["运行 ID", value.run_id ?? "未提供"],
			["已完成调用记录（含父子）", number(report.inventory.calls)], ["已解析记录", number(report.metadata.parsed_records)], ["无效记录", number(report.metadata.invalid_lines)],
		]} /><p className="report-note">新增执行指标只收集计数、耗时和固定分类，不收集代码、正文或原生路径。历史缺失值不补零；中断、崩溃和写盘失败可能导致样本不全。</p></Section>
		<TimingReport value={value.timing} />
		<ReportStamp at={report.metadata.generated_at} />
	</div>;
}
