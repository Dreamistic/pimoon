import { expect, it } from "vitest";
import { createAssistantMessageEventStream, getCurrentTools, normalizeContext, Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { codeactStream } from "../../src/pimoon/codeact/stream.ts";
import { codeactTranscript } from "../../src/pimoon/codeact/transcript.ts";
import { codeactSource, type CodeActMessage } from "../../src/pimoon/codeact/types.ts";

const model: Model<"openai-completions"> = { id: "test", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = () => normalizeContext({ messages: [{ role: "system", content: "base", toolsAdded: [{ name: "read", description: "fixture", parameters: Type.Object({ path: Type.String() }) }], timestamp: 0 }, { role: "user", content: "fixture", timestamp: 1 }] });
function message(): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function provider(text: string, reason: "stop" | "length" | "aborted" = "stop"): StreamFn {
	return (_model, request) => {
		expect(getCurrentTools(request.messages)).toEqual([]);
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "thinking", thinking: "<execute>\nnot_code()\n</execute>", thinkingSignature: "signed-fixture" });
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		stream.push({ type: "thinking_end", contentIndex: 0, content: "fixture", partial });
		partial.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: 1, partial });
		for (const delta of text) {
			const part = partial.content[1]; if (part?.type === "text") part.text += delta;
			stream.push({ type: "text_delta", contentIndex: 1, delta, partial });
		}
		stream.push({ type: "text_end", contentIndex: 1, content: text, partial });
		const thought = partial.content[0], body = partial.content[1];
		if (thought?.type === "thinking") thought.thinkingSignature = "late-signed-fixture";
		if (body?.type === "text") body.textSignature = '{"v":1,"id":"fixture","phase":"commentary"}';
		partial.usage = { ...partial.usage, input: 27, output: 13, totalTokens: 40 };
		partial.stopReason = reason;
		if (reason === "aborted") stream.push({ type: "error", reason, error: partial });
		else stream.push({ type: "done", reason, message: partial });
		stream.end(); return stream;
	};
}
async function drain(source: StreamFn) {
	const stream = await codeactStream(source)(model, context());
	const events = []; for await (const event of stream) events.push(event);
	const result: CodeActMessage = await stream.result();
	return { result, events };
}

it("源码是执行元数据，不生成任何工具事件；保留原始签名、用量和 Unicode", async () => {
	const code = "value='😀\\n原文'\nvalue\n";
	const { result, events } = await drain(provider(`说明\n<execute>\n${code}</execute> trailing metadata\nshould_not_run()`));
	expect(result.stopReason).toBe("stop");
	expect(result.usage.totalTokens).toBe(40);
	expect(result.codeact?.complete).toBe(true);
	expect(codeactSource(result)).toBe(code);
	expect(events.some(event => event.type.startsWith("toolcall_"))).toBe(false);
	expect(result.content.some(part => part.type === "toolCall")).toBe(false);
	expect(result.content[0]).toMatchObject({ thinkingSignature: "late-signed-fixture" });
	const history = context(); history.messages.push(result);
	const replay = codeactTranscript(history).messages.at(-1);
	if (replay?.role !== "assistant") throw new Error("fixture");
	expect(replay.content.filter(part => part.type === "text")).toEqual([{ type: "text", text: `说明\n<execute>\n${code}</execute>`, textSignature: '{"v":1,"id":"fixture","phase":"commentary"}' }]);
	expect(JSON.stringify(replay)).not.toContain("codeact");
	expect(JSON.stringify(result)).not.toContain("should_not_run");
	history.messages[history.messages.length - 1] = { ...result, content: result.content.filter(part => part.type !== "thinking") };
	const pruned = codeactTranscript(history).messages.at(-1);
	expect(pruned?.role === "assistant" && pruned.content.some(part => part.type === "thinking")).toBe(false);
});

it.each(["length", "aborted"] as const)("完整源码不掩盖供应商失败终态：%s", async reason => {
	expect((await drain(provider("<execute>\nchange()\n</execute>", reason))).result.stopReason).toBe(reason);
});
it("未闭合块报告错误，输出超限仍保留 length", async () => {
	expect((await drain(provider("<execute>\nchange()"))).result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("未闭合") });
	expect((await drain(provider("<execute>\nchange()", "length"))).result.stopReason).toBe("length");
});
it("无任何宿主函数仍支持纯 Python CodeAct", async () => {
	const stream = await codeactStream(provider("<execute>\n42\n</execute>"))(model, normalizeContext({ messages: [] }));
	for await (const _event of stream) { /* 排空流。 */ }
	expect(codeactSource(await stream.result())).toBe("42\n");
});
it("父级取消中止未完成源码，不补齐执行块", async () => {
	const controller = new AbortController(); let cancelled = false;
	const pending: StreamFn = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "text", text: "<execute>\nchange()" });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "<execute>\nchange()", partial });
		options?.signal?.addEventListener("abort", () => {
			cancelled = true; partial.stopReason = "aborted";
			stream.push({ type: "error", reason: "aborted", error: partial }); stream.end();
		}, { once: true });
		return stream;
	};
	const stream = await codeactStream(pending)(model, context(), { signal: controller.signal });
	for await (const event of stream) if (event.type === "text_start" && (event.partial as CodeActMessage).codeact) controller.abort();
	const result: CodeActMessage = await stream.result();
	expect(cancelled).toBe(true); expect(result.stopReason).toBe("aborted"); expect(result.codeact?.complete).toBe(false);
});
it.each([true, false])("拒绝原生工具调用，包含仅终态返回：%s", async updates => {
	const native: StreamFn = () => {
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial }); partial.content.push({ type: "toolCall", id: "fixture", name: "read", arguments: { path: "fixture" } });
		if (updates) stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		stream.push({ type: "done", reason: "toolUse", message: partial }); stream.end(); return stream;
	};
	expect((await drain(native)).result).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("原生工具调用") });
});
it("text_end 可补齐正文；更改已流式发送的源码则拒绝执行", async () => {
	for (const inconsistent of [false, true]) {
		const source: StreamFn = () => {
			const stream = createAssistantMessageEventStream(), partial = message();
			stream.push({ type: "start", partial }); partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial });
			if (inconsistent) stream.push({ type: "text_delta", contentIndex: 0, delta: "<execute>\nchange()\n</execute>\n", partial });
			const block = partial.content[0]; if (block?.type === "text") block.text = "<execute>\n42\n</execute>";
			stream.push({ type: "text_end", contentIndex: 0, content: "<execute>\n42\n</execute>", partial });
			stream.push({ type: "done", reason: "stop", message: partial }); stream.end(); return stream;
		};
		const { result } = await drain(source);
		if (inconsistent) expect(result.errorMessage).toContain("不一致");
		else expect(codeactSource(result)).toBe("42\n");
	}
});
it("不兼容旧原生工具历史，明确要求新建会话", () => {
	const original = context(), assistant = message();
	assistant.content = [{ type: "toolCall", id: "fixture", name: "read", arguments: { path: "fixture" } }];
	original.messages.push(assistant); expect(() => codeactTranscript(original)).toThrow("新建会话");
});
