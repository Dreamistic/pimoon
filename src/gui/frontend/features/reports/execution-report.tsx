import type { TelemetryReport } from "../../../../harness/telemetry-report/types.ts";
import { duration, Empty, Facts, number, Section } from "./shared.tsx";
import { distribution, rateText } from "./telemetry-format.ts";

type Code = TelemetryReport["execution"]["codeact"];
const total = (value: { samples: number; total: number }) => `${number(value.samples > 0 ? value.total : undefined)} · ${number(value.samples)} 个样本`;
const outcomeLabels: Record<string, string> = {
	success: "无失败", tool_partial_failure: "内部工具失败但执行完成", python_error: "Python 异常", timeout: "超时", cancelled: "已取消",
	startup_error: "启动失败", runtime_crash: "运行时崩溃", runtime_error: "运行时错误", unknown: "终态未知",
};

export function ExecutionReport({ code }: { code: Code }) {
	if (code.calls === 0) return <Section title="CodeAct 执行与输出"><Empty>尚无 CodeAct 执行单元。</Empty></Section>;
	return <>
		<Section title="CodeAct 执行与输出">
			<Facts items={[
				["无失败执行率", rateText(code.clean_success_rate)], ["完整执行指标", `${number(code.metrics_samples)} / ${number(code.calls)}`],
				...Object.entries(code.outcomes).map(([outcome, count]): [string, string] => [outcomeLabels[outcome] ?? outcome, number(count)]),
				...Object.entries(code.error_types).map(([type, count]): [string, string] => [`异常 · ${type}`, number(count)]),
				["每单元宿主调用", distribution(code.internal_calls)], ["内部工具失败数", total(code.internal_failures)],
			]} />
			<p className="report-note">执行单元是一次 Python 执行，宿主调用是内部 read、grep、bash 等操作，两者不相加计算成功率。无失败执行率只使用已知终态，不代表任务正确率。</p>
		</Section>
		<Section title="分层耗时" detail>
			<Facts items={[
				["宿主总墙钟", distribution(code.timing.host_ms, duration)], ["等待启动", distribution(code.timing.startup_wait_ms, duration)],
				["Python 墙钟", distribution(code.timing.python_ms, duration)], ["编译", distribution(code.timing.compile_ms, duration)],
				["桥接等待", distribution(code.bridge_wait_ms, duration)], ["Python 非桥接时间", distribution(code.timing.python_active_ms, duration)],
			]} />
			<p className="report-note">Python 墙钟包含桥接等待；非桥接时间不是 CPU 时间。并发工具耗时不直接累加。中断执行可能缺少 worker 指标。</p>
		</Section>
		<Section title="输出与反馈" detail>
			<Facts items={[
				["内部工具文本字符", total(code.output.internal)], ["Python 产生字符", total(code.output.produced)],
				["保留字符", total(code.output.retained)], ["展示字符", total(code.output.displayed)], ["返回模型字符", total(code.output.returned)],
				["标准输出字符", total(code.output.stdout)], ["标准错误字符", total(code.output.stderr)],
				["自动预览值", total(code.output.auto_results)], ["末尾表达式结果", total(code.output.expressions)],
				["展示截断", rateText(code.display_truncated)], ["保留不完整", rateText(code.retention_incomplete)],
			]} />
			<p className="report-note">内部结果不等于模型曝光。各层字符可能重叠，不计算压缩率或节省 Token；返回模型字符不含图片与协议开销。</p>
		</Section>
		<Section title="Python 原生操作" detail>
			<Facts items={[
				["只读打开尝试", total(code.native.file_reads)], ["写入打开尝试", total(code.native.file_writes)],
				["目录列举尝试", total(code.native.directory_lists)], ["文件系统变更尝试", total(code.native.mutations)],
			]} />
			<p className="report-note">审计计数是尝试次数，含被拒绝操作、库导入和路径检查；不是成功数、文件数或实际写入量，也不覆盖任意项目函数的业务语义。</p>
		</Section>
		<Section title="只读批处理与状态" detail>
			<Facts items={[
				["批次数", total(code.batch.calls)], ["作业数", total(code.batch.jobs)], ["完成作业数", total(code.batch.completed)],
				["失败作业数", total(code.batch.failures)], ["每单元峰值并发", distribution(code.batch.peak_concurrency)],
				["复用已有 Python 状态", rateText(code.state.reused)], ["状态丢失", rateText(code.state.lost)], ["运行时重新初始化", rateText(code.state.reinitialized)],
			]} />
			<p className="report-note">批处理只统计 batch；状态复用指进程已有执行历史，不推断某个变量被使用。取消、超时不回滚已完成写入。未知指标保留为空。</p>
		</Section>
	</>;
}
