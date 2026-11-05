import type { GuiToolOutput, ToolState } from "../../../../shared/messages/types.ts";
import { outputPreview } from "../../../../shared/messages/output.ts";
import { clean, record } from "@/ui/content/format.ts";

export function codeActOutcome(output: GuiToolOutput | undefined): string {
	const details = outputPreview(output)?.details;
	return record(details) && record(details.metrics) && typeof details.metrics.outcome === "string" ? details.metrics.outcome : "";
}

/** 只摘录输出，不从源码或模型给出的目的推断执行结果。 */
export function codeActOutputSummary(output: GuiToolOutput | undefined, failed = false): string {
	const content = outputPreview(output)?.content;
	if (!Array.isArray(content)) return "";
	const text = content.flatMap(block => record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
	const lines = clean(text).split("\n").map(line => line.trim()).filter(Boolean);
	if (failed) {
		const exception = lines.findLast(line => /^(?:[\w.]*Error|[\w.]*Exception):/u.test(line));
		if (exception) return compact(exception);
	}
	const body = lines.filter(line => !/^(?:ok|error|partial_failure)$/u.test(line) && !/^(?:calls:|tool_failures:|Traceback \()/u.test(line));
	return compact(body[0] ?? "");
}

export function codeActStateLabel(state: ToolState, outcome: string, waiting: boolean, hasInternalFailures = false): string | undefined {
	if (waiting) return "等待确认";
	if (outcome === "confirmation_rejected") return "已拒绝 · 未执行";
	if (outcome === "confirmation_unavailable" || outcome === "confirmation_invalidated") return "未获确认 · 未执行";
	if (state === "preparing") return "生成代码";
	if (state === "completed") return outcome === "tool_partial_failure" || hasInternalFailures ? "执行完成 · 有内部失败" : "执行完成";
	return undefined;
}

function compact(text: string): string {
	const value = text.replace(/\s+/gu, " ").trim();
	return value.length > 180 ? `${value.slice(0, 180)}…` : value;
}
