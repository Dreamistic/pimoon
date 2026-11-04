import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";
import { CodeActParser, type CodeActChunk } from "./parser.ts";
import { codeactTranscript, type CodeActMessage } from "./transcript.ts";

/** 替换模型传输协议，不改 SDK 内部的审批、工具事件、取消和会话持久化。 */
export function codeactStream(provider: StreamFn): StreamFn {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			let message: CodeActMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			const controller = new AbortController();
			const abort = () => controller.abort();
			options?.signal?.addEventListener("abort", abort, { once: true });
			if (options?.signal?.aborted) abort();
			let settled = false;
			try {
				const request = codeactTranscript(context);
				const source = await provider(model, request.context, { ...options, signal: controller.signal });
				const parser = new CodeActParser();
				const thinking = new Map<number, number>();
				const textReceived = new Map<number, string>();
				let textIndex: number | undefined, callIndex: number | undefined;
				let call: ToolCall | undefined;
				const closeText = () => {
					const part = textIndex === undefined ? undefined : message.content[textIndex];
					if (part?.type === "text" && textIndex !== undefined) output.push({ type: "text_end", contentIndex: textIndex, content: part.text, partial: message });
					textIndex = undefined;
				};
				const appendText = (text: string) => {
					if (!text) return;
					if (textIndex === undefined) {
						textIndex = message.content.length;
						message.content.push({ type: "text", text: "" });
						output.push({ type: "text_start", contentIndex: textIndex, partial: message });
					}
					const part = message.content[textIndex];
					if (part?.type !== "text") throw new Error("CodeAct 正文状态无效。");
					part.text += text;
					output.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: message });
				};
				const accept = (chunks: CodeActChunk[]) => {
					for (const chunk of chunks) {
						if (chunk.type === "text") appendText(chunk.text);
						else if (chunk.type === "open") {
							closeText();
							callIndex = message.content.length;
							call = { type: "toolCall", id: randomUUID(), name: "codemode", arguments: { code: "" } };
							message.content.push(call);
							output.push({ type: "toolcall_start", contentIndex: callIndex, partial: message });
							output.push({ type: "toolcall_delta", contentIndex: callIndex, delta: '{"code":"', partial: message });
						} else if (call && callIndex !== undefined && chunk.type === "code") {
							call.arguments.code = String(call.arguments.code) + chunk.text;
							output.push({ type: "toolcall_delta", contentIndex: callIndex, delta: JSON.stringify(chunk.text).slice(1, -1), partial: message });
						} else if (call && callIndex !== undefined && chunk.type === "close") {
							if (!String(call.arguments.code).trim()) throw new Error("CodeAct 执行块为空，代码未执行。");
							output.push({ type: "toolcall_delta", contentIndex: callIndex, delta: '"}', partial: message });
							output.push({ type: "toolcall_end", contentIndex: callIndex, toolCall: call, partial: message });
						}
					}
				};
				const acceptText = (index: number, delta: string) => {
					textReceived.set(index, (textReceived.get(index) ?? "") + delta);
					if (request.enabled) accept(parser.feed(delta));
					else appendText(delta);
				};
				for await (const event of source) {
					if (event.type === "start") {
						message = { ...event.partial, content: [] };
						output.push({ type: "start", partial: message });
					} else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
						throw new Error("文本 CodeAct 协议不接受 API 原生工具调用，代码未执行。");
					} else if (event.type === "text_delta") {
						acceptText(event.contentIndex, event.delta);
					} else if (event.type === "text_end") {
						const received = textReceived.get(event.contentIndex) ?? "";
						if (!event.content.startsWith(received)) throw new Error("模型正文终态与流式内容不一致，代码未执行。");
						acceptText(event.contentIndex, event.content.slice(received.length));
						const part = textIndex === undefined ? undefined : message.content[textIndex];
						const original = event.partial.content[event.contentIndex];
						if (part?.type === "text" && original?.type === "text" && original.textSignature !== undefined) part.textSignature = original.textSignature;
					} else if (event.type === "thinking_start") {
						closeText();
						const original = event.partial.content[event.contentIndex];
						if (original?.type !== "thinking") throw new Error("模型思考块无效。");
						const index = message.content.length;
						thinking.set(event.contentIndex, index);
						message.content.push({ ...original, thinking: original.redacted ? original.thinking : "" });
						output.push({ type: "thinking_start", contentIndex: index, partial: message });
					} else if (event.type === "thinking_delta" || event.type === "thinking_end") {
						const index = thinking.get(event.contentIndex);
						const part = index === undefined ? undefined : message.content[index];
						if (index === undefined || part?.type !== "thinking") continue;
						if (event.type === "thinking_delta") {
							part.thinking += event.delta;
							output.push({ type: "thinking_delta", contentIndex: index, delta: event.delta, partial: message });
						} else {
							const original = event.partial.content[event.contentIndex];
							if (original?.type === "thinking") Object.assign(part, original);
							output.push({ type: "thinking_end", contentIndex: index, content: part.thinking, partial: message });
						}
					}
				}
				const final = await source.result();
				settled = true;
				const content = message.content;
				Object.assign(message, final, { content });
				// Responses 的 reasoning 签名可能在终态补齐，必须使用最终块。
				for (const [sourceIndex, index] of thinking) {
					const original = final.content[sourceIndex], part = content[index];
					if (original?.type === "thinking" && part?.type === "thinking") Object.assign(part, original);
				}
				if (final.stopReason === "error" || final.stopReason === "aborted") {
					output.push({ type: "error", reason: final.stopReason, error: message });
				} else {
					for (const [index, part] of final.content.entries()) {
						if (part.type === "toolCall") throw new Error("文本 CodeAct 协议不接受 API 原生工具调用，代码未执行。");
						if (part.type === "text" && part.text !== (textReceived.get(index) ?? "")) throw new Error("模型正文终态与流式内容不一致，代码未执行。");
					}
					if (request.enabled && (final.stopReason !== "length" || parser.closed)) accept(parser.finish());
					closeText();
					let remaining = parser.closed ? parser.consumed : Infinity;
					message.codeactContent = final.content.flatMap((part): CodeActMessage["content"] => {
						if (part.type !== "text") return [part];
						const text = part.text.slice(0, remaining);
						remaining -= text.length;
						return text ? [{ ...part, text }] : [];
					});
					// 保留供应商终态与用量；length 即使已闭合也交由 SDK 拒绝执行。
					if (final.stopReason === "pending") throw new Error("模型响应尚未完成，代码未执行。");
					const reason = call && final.stopReason === "stop" ? "toolUse" : final.stopReason;
					message.stopReason = reason;
					output.push({ type: "done", reason, message });
				}
			} catch (error) {
				message.stopReason = options?.signal?.aborted ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				output.push({ type: "error", reason: message.stopReason, error: message });
			} finally {
				if (!settled) controller.abort();
				options?.signal?.removeEventListener("abort", abort);
				output.end();
			}
		})();
		return output;
	};
}
