import { normalizeContext, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isCodeActResultMessage } from "./types.ts";
import type { CodeActMessage } from "./types.ts";
export type { CodeActMessage } from "./types.ts";

/** 执行结果只在模型投影中转换；持久化原文和裁剪恢复使用同一契约。 */
export function codeactResultToUser(message: AgentMessage): AgentMessage {
	if (!isCodeActResultMessage(message)) return message;
	const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
	const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
	return { role: "user", timestamp: message.timestamp, content: [
		{ type: "text", text: `<execute_result status="${message.details.isError ? "error" : "ok"}">\n${text}\n</execute_result>` },
		...content.filter(part => part.type === "image"),
	] };
}

/** 模型只接收文本 CodeAct；SDK 的内部能力声明不进入请求。 */
export function codeactTranscript(context: TranscriptContext, instructions = ""): TranscriptContext {
	const messages: Message[] = context.messages.map(message => {
		if (message.role === "system") {
			const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
			return rest;
		}
		if (message.role === "toolResult" || message.role === "assistant" && message.content.some(part => part.type === "toolCall"))
			throw new Error("CodeAct 不接受原生工具历史，请新建会话。");
		if (message.role !== "assistant") return message;
		const { codeact: _execution, codeactContent, codeactStop: _stop, ...rest }: CodeActMessage = message;
		if (!codeactContent) return rest;
		const content = codeactContent.flatMap((part): CodeActMessage["content"] => {
			if (part.type !== "thinking") return [part];
			const retained = message.content.find(candidate => candidate.type === "thinking" && (part.thinkingSignature !== undefined
				? candidate.thinkingSignature === part.thinkingSignature : candidate.thinking === part.thinking));
			return retained ? [retained] : [];
		});
		return { ...rest, content };
	});
	if (instructions) {
		const first = messages[0];
		if (first?.role === "system") messages[0] = { ...first, sections: { ...first.sections, pimoon_codeact: instructions } };
		else messages.unshift({ role: "system", content: instructions, timestamp: 0 });
	}
	return normalizeContext({ messages });
}
