import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { CodeActParser, type CodeActChunk } from "./parser.ts";
import { codeactTranscript, type CodeActMessage } from "./transcript.ts";

const stopSequence = Symbol("codeact.stop_sequence");
export const USAGE_SETTLE_GRACE_MS = 250;

/** 给同一响应的正常终态留有限窗口；不无限续等，也不发补账请求。 */
async function settleGrace(result: Promise<AssistantMessage>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	try {
		await Promise.race([result, new Promise<void>(resolve => {
			abort = resolve;
			signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(resolve, USAGE_SETTLE_GRACE_MS);
		})]);
	} finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

/** 取消必须完成收尾；超时不启动代码。 */
async function stoppedResult(result: Promise<AssistantMessage>): Promise<AssistantMessage> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([result, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("停止模型流未能完成，代码未执行。")), 5000);
		})]);
	} finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 替换模型传输协议，不改 SDK 内部的审批、工具事件、取消和会话持久化。 */
export function codeactStream(provider: StreamFn, instructions: () => string = () => ""): StreamFn {
	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			let message: CodeActMessage = {
				role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			const controller = new AbortController();
			const abort = () => controller.abort(options?.signal?.reason);
			options?.signal?.addEventListener("abort", abort, { once: true });
			if (options?.signal?.aborted) abort();
			let settled = false;
			try {
				const request = codeactTranscript(context, instructions());
				const source = await provider(model, request, { ...options, signal: controller.signal });
				let providerFinished = false, locallyStopped = false;
				const result = source.result().then(final => { providerFinished = true; return final; });
				// 解析提前失败时也会取消源流；其终态拒绝不能变成未处理的 Promise。
				void result.catch(() => {});
				const parser = new CodeActParser();
				const thinking = new Map<number, number>();
				const textReceived = new Map<number, string>();
				let receivedText = "";
				let sourceTextIndex: number | undefined;
				let textIndex: number | undefined, codeIndex: number | undefined;
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
							codeIndex = message.content.length;
							message.codeact = { id: randomUUID(), index: codeIndex, complete: false, ...chunk.metadata };
							message.content.push({ type: "text", text: "" });
							output.push({ type: "text_start", contentIndex: codeIndex, partial: message });
						} else if (codeIndex !== undefined) {
							const block = message.content[codeIndex];
							if (block?.type !== "text") throw new Error("CodeAct 源码状态无效。");
							if (chunk.type === "code") {
								block.text += chunk.text;
								output.push({ type: "text_delta", contentIndex: codeIndex, delta: chunk.text, partial: message });
							} else if (chunk.type === "close" && message.codeact) {
								if (!block.text.trim()) throw new Error("CodeAct 执行块为空，代码未执行。");
								message.codeact.complete = true;
								output.push({ type: "text_end", contentIndex: codeIndex, content: block.text, partial: message });
							}
						}
					}
				};
				const acceptText = (index: number, delta: string) => {
					if (sourceTextIndex !== index) {
						accept(parser.textBoundary());
						closeText();
						sourceTextIndex = index;
					}
					textReceived.set(index, (textReceived.get(index) ?? "") + delta);
					receivedText += delta;
					accept(parser.feed(delta));
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
					} else if (event.type === "thinking_start" && !parser.closed) {
						closeText();
						const original = event.partial.content[event.contentIndex];
						if (original?.type !== "thinking") throw new Error("模型思考块无效。");
						const index = message.content.length;
						thinking.set(event.contentIndex, index);
						message.content.push({ ...original, thinking: original.redacted ? original.thinking : "" });
						output.push({ type: "thinking_start", contentIndex: index, partial: message });
					} else if ((event.type === "thinking_delta" || event.type === "thinking_end") && !parser.closed) {
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
					if (parser.closed) {
						// 先让已经排队的终态结算，不能把已失败的响应改判为主动截停。
						await Promise.resolve();
						if (!providerFinished && !controller.signal.aborted) await settleGrace(result, controller.signal);
						if (!providerFinished && !controller.signal.aborted) {
							locallyStopped = true;
							controller.abort(stopSequence);
							break;
						}
					}
				}
				const final = await (locallyStopped ? stoppedResult(result) : result);
				const sequenceStopped = locallyStopped && controller.signal.reason === stopSequence
					&& !options?.signal?.aborted && final.stopReason === "aborted";
				const nativeComplete = ["completed", "stop", "end_turn", "stop_sequence"].includes(final.rawStopReason ?? "");
				const incompleteStop = sequenceStopped && !nativeComplete;
				settled = true;
				const content = message.content;
				Object.assign(message, final, { content });
				if (sequenceStopped && final.rawStopReason !== undefined && !nativeComplete) {
					throw new Error("模型返回未完成终态，代码未执行。");
				}
				// Responses 的 reasoning 签名可能在终态补齐，必须使用最终块。
				for (const [sourceIndex, index] of thinking) {
					const original = final.content[sourceIndex], part = content[index];
					if (original?.type === "thinking" && part?.type === "thinking") Object.assign(part, original);
				}
				if (final.stopReason === "error" || final.stopReason === "aborted" && !sequenceStopped) {
					output.push({ type: "error", reason: final.stopReason, error: message });
				} else {
					for (const [index, part] of final.content.entries()) {
						if (part.type === "toolCall") throw new Error("文本 CodeAct 协议不接受 API 原生工具调用，代码未执行。");
						if (!sequenceStopped && part.type === "text" && part.text !== (textReceived.get(index) ?? "")) throw new Error("模型正文终态与流式内容不一致，代码未执行。");
					}
					if (sequenceStopped) {
						const finalText = final.content.filter(part => part.type === "text").map(part => part.text).join("");
						if (!finalText.startsWith(receivedText.slice(0, parser.consumed))) throw new Error("模型正文终态与流式内容不一致，代码未执行。");
						message.codeactStop = { sequence: "</execute>", usage: final.usage.totalTokens > 0 ? incompleteStop ? "partial" : "complete" : "unavailable" };
						delete message.errorMessage;
						if (incompleteStop) delete message.responseId;
						message.rawStopReason = "codeact_stop_sequence";
					}
					if (final.stopReason !== "length" || parser.closed) accept(parser.finish());
					closeText();
					let remaining = parser.closed ? parser.consumed : Infinity;
					message.codeactContent = final.content.flatMap((part, sourceIndex): CodeActMessage["content"] => {
						if (part.type !== "text") return incompleteStop || !thinking.has(sourceIndex) ? [] : [part];
						const text = part.text.slice(0, remaining);
						remaining -= text.length;
						if (!text) return [];
						// 未收到正常终态时，不重放未完成的供应商签名和 phase。
						const { textSignature: _signature, ...unsigned } = part;
						return [{ ...(incompleteStop ? unsigned : part), text }];
					});
					// 保留供应商终态与用量；length 即使已闭合也交由 SDK 拒绝执行。
					if (final.stopReason === "pending") throw new Error("模型响应尚未完成，代码未执行。");
					message.stopReason = sequenceStopped ? "stop" : final.stopReason;
					if (message.stopReason === "aborted") throw new Error("模型响应尚未完成，代码未执行。");
					output.push({ type: "done", reason: message.stopReason, message });
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
