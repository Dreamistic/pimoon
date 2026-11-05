import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CodeActMessage } from "../../pimoon/codeact/types.ts";
import { isCodeActResultMessage } from "../../pimoon/codeact/types.ts";

const RETAIN_RECENT = 2;
const MIN_OUTPUT_CHARS = 2048;
const READ_ONLY_TOOLS = new Set(["read", "find", "grep", "ls"]);

/** 只关联唯一且按执行顺序闭合的结果，重复 ID 或缺失执行块不猜测关联。 */
export function completedCodeActResults(messages: readonly AgentMessage[]) {
	const executions = new Map<string, number[]>();
	const results = new Map<string, number[]>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "assistant") {
			const assistant: CodeActMessage = message;
			const execution = assistant.codeact;
			if (execution?.complete && message.stopReason === "stop") {
				const indices = executions.get(execution.id) ?? [];
				indices.push(index); executions.set(execution.id, indices);
			}
		} else if (isCodeActResultMessage(message)) {
			const entries = results.get(message.details.id) ?? [];
			entries.push(index); results.set(message.details.id, entries);
		}
	}
	return messages.filter(isCodeActResultMessage).filter(message => {
		const starts = executions.get(message.details.id), ends = results.get(message.details.id);
		return starts?.length === 1 && ends?.length === 1 && (starts[0] ?? Infinity) < (ends[0] ?? -1);
	});
}

/** 仅裁剪旧的成功查询输出；修改、进程、部分失败及不完整嵌套记录继续保留。 */
export function codeActPruneCandidates(messages: readonly AgentMessage[]): Set<string> {
	const completed = completedCodeActResults(messages);
	const recent = new Set(completed.slice(-RETAIN_RECENT).map(message => message.details.id));
	return new Set(completed.filter(message => {
		const detail = message.details;
		if (recent.has(detail.id) || !safeQueryOutput(message)) return false;
		const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		return content.some(part => part.type === "image")
			|| content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0) >= MIN_OUTPUT_CHARS;
	}).map(message => message.details.id));
}

export function pruneCodeActOutput(message: AgentMessage, ids: ReadonlySet<string>): AgentMessage | undefined {
	if (!isCodeActResultMessage(message) || !safeQueryOutput(message) || !ids.has(message.details.id)) return;
	return { ...message, content: `[pruned output id=${message.details.id}; code/history retained; /prune restore]`,
		details: { ...message.details, pruned: true } };
}

function safeQueryOutput(message: ReturnType<typeof completedCodeActResults>[number]): boolean {
	const detail = message.details;
	return !detail.pruned && !detail.isError && detail.metrics.outcome === "success"
		&& detail.nestedCalls?.complete === true && detail.nestedCalls.calls.length > 0
		&& detail.nestedCalls.calls.every(call => call.status === "ok" && READ_ONLY_TOOLS.has(call.name));
}
