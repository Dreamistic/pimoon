import { afterEach, expect, it, vi } from "vitest";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { codeactStream, USAGE_SETTLE_GRACE_MS } from "../../src/pimoon/codeact/stream.ts";
import { codeactSource, type CodeActMessage } from "../../src/pimoon/codeact/types.ts";
import { responseUsageStatus } from "../../src/pimoon/usage-status.ts";

const model: Model<"openai-responses"> = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-responses", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 1000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
const text = "<execute>\n42\n</execute> ignored suffix";
const context = normalizeContext({ messages: [] });
const drain = async (stream: Awaited<ReturnType<StreamFn>>): Promise<CodeActMessage> => { for await (const _event of stream) { /* 排空流。 */ } return stream.result(); };
function delayedProvider(delay: number, reason: "stop" | "error" | "length" = "stop", trailingThinking = false) {
	let calls = 0, aborts = 0;
	const provider: StreamFn = (_model, _context, options) => {
		calls++;
		const stream = createAssistantMessageEventStream();
		const partial: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider, timestamp: 0, stopReason: "pending",
			content: [{ type: "text", text }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		const timer = setTimeout(() => {
			options?.signal?.removeEventListener("abort", abort);
			partial.usage = { ...partial.usage, input: 12, output: 2, totalTokens: 14, cost: { ...partial.usage.cost, total: 0.001 } };
			partial.stopReason = reason; partial.rawStopReason = reason === "length" ? "max_output_tokens" : reason === "error" ? "failed" : "completed";
			partial.responseId = "completed-fixture";
			if (trailingThinking) {
				partial.content.push({ type: "thinking", thinking: "unexecuted trailing claim", thinkingSignature: "trailing-signature" });
				stream.push({ type: "thinking_start", contentIndex: 1, partial });
				stream.push({ type: "thinking_end", contentIndex: 1, content: "unexecuted trailing claim", partial });
			}
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
			if (reason === "error") stream.push({ type: "error", reason, error: partial });
			else stream.push({ type: "done", reason, message: partial });
			stream.end();
		}, delay);
		const abort = () => {
			aborts++; clearTimeout(timer); partial.stopReason = "aborted";
			stream.push({ type: "error", reason: "aborted", error: partial }); stream.end();
		};
		options?.signal?.addEventListener("abort", abort, { once: true });
		return stream;
	};
	return { provider, calls: () => calls, aborts: () => aborts };
}

afterEach(() => vi.useRealTimers());

it("闭合后短窗口回收同一请求的完整 usage，仍丢弃后缀，不额外请求", async () => {
	vi.useFakeTimers();
	const source = delayedProvider(20);
	const result = drain(await codeactStream(source.provider)(model, context));
	await vi.advanceTimersByTimeAsync(25);
	const message = await result;
	expect(message.stopReason).toBe("stop");
	expect(message.usage.totalTokens).toBe(14);
	expect(responseUsageStatus(message)).toBe("complete");
	expect(codeactSource(message)).toBe("42\n");
	expect(JSON.stringify(message.codeactContent)).not.toContain("ignored suffix");
	expect(message.responseId).toBe("completed-fixture");
	expect(source.calls()).toBe(1); expect(source.aborts()).toBe(0);
});

it("为回收 usage 排空源流时，闭合后的新思考也不进入展示或历史回放", async () => {
	vi.useFakeTimers();
	const source = delayedProvider(20, "stop", true);
	const result = drain(await codeactStream(source.provider)(model, context));
	await vi.advanceTimersByTimeAsync(25);
	const message = await result;
	expect(message.usage.totalTokens).toBe(14);
	expect(JSON.stringify(message)).not.toContain("unexecuted trailing claim");
	expect(JSON.stringify(message)).not.toContain("trailing-signature");
});

it("超过短窗口仍截流并保留未知，不为完整统计持续等模型", async () => {
	vi.useFakeTimers();
	const source = delayedProvider(USAGE_SETTLE_GRACE_MS + 1000);
	const result = drain(await codeactStream(source.provider)(model, context));
	await vi.advanceTimersByTimeAsync(USAGE_SETTLE_GRACE_MS + 1);
	expect(await result).toMatchObject({ stopReason: "stop", codeactStop: { usage: "unavailable" } });
	expect(source.calls()).toBe(1); expect(source.aborts()).toBe(1);
});

it.each(["error", "length"] as const)("宽限窗口内收到 %s，不把完整代码误判成可执行成功", async reason => {
	vi.useFakeTimers();
	const source = delayedProvider(20, reason);
	const result = drain(await codeactStream(source.provider)(model, context));
	await vi.advanceTimersByTimeAsync(25);
	expect((await result).stopReason).toBe(reason);
	expect(source.aborts()).toBe(0);
});

it("窗口等待期间用户取消优先，清理源流与计时器", async () => {
	vi.useFakeTimers();
	const source = delayedProvider(1000), controller = new AbortController();
	const result = drain(await codeactStream(source.provider)(model, context, { signal: controller.signal }));
	await vi.advanceTimersByTimeAsync(10); controller.abort();
	await vi.advanceTimersByTimeAsync(1);
	expect((await result).stopReason).toBe("aborted");
	expect(source.aborts()).toBe(1);
	expect(vi.getTimerCount()).toBe(0);
});
