import { afterEach, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { stream as codexStream } from "../../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js";
import { codeactStream } from "../../src/pimoon/codeact/stream.ts";
import { codeactTranscript, type CodeActMessage } from "../../src/pimoon/codeact/transcript.ts";

const model: Model<"openai-codex-responses"> = { id: "fixture", name: "Fixture", api: "openai-codex-responses", provider: "openai-codex", baseUrl: "https://codex.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const entry = { name: "codemode", description: "Python fixture", parameters: Type.Object({ code: Type.String() }) };
const context = () => normalizeContext({ messages: [{ role: "system", content: "fixture", toolsAdded: [entry], timestamp: 0 }] });
const code = "value=42\nvalue\n";
const block = `<execute>\n${code}</execute>`;
function message(): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, responseId: "unfinished-response", timestamp: Date.now(), stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
const drain = async (stream: Awaited<ReturnType<StreamFn>>) => { for await (const _event of stream) { /* 排空流。 */ } return stream.result(); };

/** 不发送正常终态，只有真正收到取消信号才结束；模拟闭合后仍等待生成的请求。 */
function liveProvider(onAbort: () => void, partialTokens = 0, settle = true): StreamFn {
	return (_model, _context, options) => {
		const stream = createAssistantMessageEventStream(), partial = message();
		partial.usage.input = partial.usage.totalTokens = partialTokens;
		stream.push({ type: "start", partial });
		partial.content.push({ type: "thinking", thinking: "fixture", thinkingSignature: "incomplete-signature" });
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		stream.push({ type: "thinking_end", contentIndex: 0, content: "fixture", partial });
		partial.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 1, partial });
		options?.signal?.addEventListener("abort", () => {
			onAbort();
			if (!settle) return;
			partial.stopReason = "aborted";
			partial.errorMessage = "Request was aborted";
			stream.push({ type: "error", reason: "aborted", error: partial }); stream.end();
		}, { once: true });
		for (const delta of ["<execute>\n" + code + "</exec", "ute> ignored suffix"]) {
			const part = partial.content[1];
			if (part?.type === "text") part.text += delta;
			stream.push({ type: "text_delta", contentIndex: 1, delta, partial });
		}
		return stream;
	};
}

afterEach(() => vi.useRealTimers());

it.each([0, 12])("完整块关闭后主动截流，不冒充用户取消；用量=%s", async tokens => {
	let aborted = 0;
	const parent = new AbortController();
	const stream = await codeactStream(liveProvider(() => { aborted++; }, tokens))(model, context(), { signal: parent.signal });
	const result: CodeActMessage = await drain(stream);
	expect(aborted).toBe(1);
	expect(parent.signal.aborted).toBe(false);
	expect(result.stopReason).toBe("toolUse");
	expect(result.errorMessage).toBeUndefined();
	expect(result.responseId).toBeUndefined();
	expect(result.codeactStop).toEqual({ sequence: "</execute>", usage: tokens ? "partial" : "unavailable" });
	expect(result.usage.totalTokens).toBe(tokens);
	expect(result.content.find(part => part.type === "toolCall")).toMatchObject({ arguments: { code } });
	const history = context(); history.messages.push(result);
	const replay = codeactTranscript(history).context.messages.at(-1);
	if (replay?.role !== "assistant") throw new Error("fixture");
	expect(replay.content.some(part => part.type === "thinking")).toBe(false);
	expect(JSON.stringify(replay)).not.toContain("codeactStop");
	expect(JSON.stringify(replay)).not.toContain("incomplete-signature");
	expect(JSON.stringify(replay)).not.toContain("ignored suffix");
});

it("截流收尾时的用户取消优先，不启动代码", async () => {
	const controller = new AbortController();
	const stream = await codeactStream(liveProvider(() => controller.abort()))(model, context(), { signal: controller.signal });
	const result: CodeActMessage = await drain(stream);
	expect(result.stopReason).toBe("aborted");
	expect(result.codeactStop).toBeUndefined();
});

it("不响应截流的宿主收尾超时后拒绝执行", async () => {
	vi.useFakeTimers();
	let aborted = false;
	const stream = await codeactStream(liveProvider(() => { aborted = true; }, 0, false))(model, context());
	const finished = drain(stream);
	await vi.waitFor(() => expect(aborted).toBe(true));
	await vi.advanceTimersByTimeAsync(5000);
	expect(await finished).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("停止模型流未能完成") });
});

it.each(["absent", "completed", "incomplete"] as const)("真实 Codex SSE 截流与同批次原生终态：%s", async terminalStatus => {
	let requests = 0, cancelled = 0, executed = 0;
	const payloads: unknown[] = [];
	const event = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
	const fetchFixture: typeof fetch = async () => {
		const current = ++requests;
		return new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				const packets: Uint8Array[] = [];
				const send = (value: unknown) => packets.push(event(value));
				send({ type: "response.created", response: { id: `response-${current}` } });
				send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `message-${current}`, role: "assistant", phase: "commentary", content: [] } });
				const text = current === 1 ? block : "done";
				send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text });
				if (current === 1 && terminalStatus === "absent") { controller.enqueue(Buffer.concat(packets)); return; }
				send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: `message-${current}`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } });
				const incomplete = current === 1 && terminalStatus === "incomplete";
				send({ type: incomplete ? "response.incomplete" : "response.completed", response: { id: `response-${current}`, status: incomplete ? "incomplete" : "completed", incomplete_details: incomplete ? { reason: "max_output_tokens" } : undefined, output: [], usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 } } });
				controller.enqueue(Buffer.concat(packets));
				controller.close();
			},
			cancel() { cancelled++; },
		}), { headers: { "content-type": "text/event-stream" } });
	};
	const fakePayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64");
	const provider: StreamFn = (_model, request, options) => codexStream(model, request, {
		...options, transport: "sse", apiKey: `synthetic.${fakePayload}.synthetic`, fetch: fetchFixture, maxRetries: 0,
		onPayload(payload) { payloads.push(payload); },
	});
	const agent = new Agent({ initialState: { model, tools: [{ ...entry, label: "fixture", async execute(_id, args) {
		executed++; expect(args).toEqual({ code }); return { content: [{ type: "text", text: "completed once" }], details: {} };
	} }] }, streamFn: codeactStream(provider) });
	await agent.prompt("Run the synthetic fixture once.");
	expect(cancelled).toBe(terminalStatus === "absent" ? 1 : 0);
	expect(executed).toBe(terminalStatus === "incomplete" ? 0 : 1);
	for (const payload of payloads) {
		expect(payload).not.toHaveProperty("stop");
		expect(payload).not.toHaveProperty("tools");
		expect(JSON.stringify(payload)).not.toContain("codeactStop");
	}
	const responses = agent.state.messages.filter(message => message.role === "assistant");
	if (terminalStatus === "incomplete") {
		expect(["error", "length"]).toContain(responses[0]?.stopReason);
		return;
	}
	expect(requests).toBe(2);
	if (terminalStatus === "completed") {
		expect(responses[0]).toMatchObject({ stopReason: "toolUse", usage: { totalTokens: 14 } });
		const first: CodeActMessage | undefined = responses[0];
		expect(first?.codeactStop?.usage ?? "complete").toBe("complete");
	} else expect(responses[0]).toMatchObject({ stopReason: "toolUse", codeactStop: { usage: "unavailable" } });
	expect(responses[1]).toMatchObject({ stopReason: "stop", usage: { totalTokens: 14 } });
});
