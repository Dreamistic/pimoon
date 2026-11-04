import { normalizeContext, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import type { CodeActMessage } from "./types.ts";
export type { CodeActMessage } from "./types.ts";

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
