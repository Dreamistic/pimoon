import { expect, it } from "vitest";
import { Type, createAssistantMessageEventStream, getCurrentTools, normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { codeactStream } from "../../src/pimoon/codeact/stream.ts";
import { codeactTranscript } from "../../src/pimoon/codeact/transcript.ts";

const model: Model<"openai-completions"> = { id: "test", name: "Fixture", api: "openai-completions", provider: "fixture", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const entry = { name: "codemode", description: "Persistent Python fixture", parameters: Type.Object({ code: Type.String() }) };
const context = (enabled = true) => normalizeContext({ messages: [{ role: "system", content: "base", toolsAdded: enabled ? [entry] : [], timestamp: 0 }, { role: "user", content: "fixture", timestamp: 1 }] });
function message(): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function provider(text: string, reason: "stop" | "length" | "aborted" = "stop"): StreamFn {
	return (_model, request) => {
		expect(getCurrentTools(request.messages)).toEqual([]);
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const partial = message();
			stream.push({ type: "start", partial });
			partial.content.push({ type: "thinking", thinking: "", thinkingSignature: "signed-fixture" });
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			const thought = partial.content[0];
			if (thought?.type !== "thinking") throw new Error("fixture");
			thought.thinking = "<execute>\nnot_code()\n</execute>";
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: thought.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: thought.thinking, partial });
			partial.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 1, partial });
			for (const delta of text) {
				const part = partial.content[1];
				if (part?.type === "text") part.text += delta;
				stream.push({ type: "text_delta", contentIndex: 1, delta, partial });
			}
			stream.push({ type: "text_end", contentIndex: 1, content: text, partial });
			await Promise.resolve();
			thought.thinkingSignature = "late-signed-fixture";
			const textPart = partial.content[1];
			if (textPart?.type === "text") textPart.textSignature = '{"v":1,"id":"msg-fixture","phase":"commentary"}';
			partial.usage = { ...partial.usage, input: 27, output: 13, totalTokens: 40 };
			partial.stopReason = reason;
			if (reason === "aborted") stream.push({ type: "error", reason, error: partial });
			else stream.push({ type: "done", reason, message: partial });
			stream.end();
		})();
		return stream;
	};
}

it("已经自然结束的流保留完整用量与签名，不重复中断；代码后缀不进入历史", async () => {
	const stream = await codeactStream(provider("说明\n<execute>\nvalue='😀\\n原文'\nvalue\n</execute>\n臆测结果"))(model, context());
	const events = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "toolcall_end") {
			expect(event.toolCall.arguments.code).toBe("value='😀\\n原文'\nvalue\n");
		}
	}
	const result = await stream.result();
	expect(result.stopReason).toBe("toolUse");
	expect(result.usage).toMatchObject({ input: 27, output: 13, totalTokens: 40 });
	expect("codeactStop" in result).toBe(false);
	expect(result.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "late-signed-fixture" });
	const history = context(); history.messages.push(result);
	const replay = codeactTranscript(history).context.messages.at(-1);
	if (replay?.role !== "assistant") throw new Error("fixture");
	const textParts = replay.content.filter(part => part.type === "text");
	expect(textParts).toHaveLength(1);
	expect(textParts[0]).toMatchObject({ textSignature: '{"v":1,"id":"msg-fixture","phase":"commentary"}' });
	expect(textParts[0]?.text).toContain("<execute>");
	expect("codeactContent" in replay).toBe(false);
	history.messages[history.messages.length - 1] = { ...result, content: result.content.filter(part => part.type !== "thinking") };
	const pruned = codeactTranscript(history).context.messages.at(-1);
	if (pruned?.role !== "assistant") throw new Error("fixture");
	expect(pruned.content.some(part => part.type === "thinking")).toBe(false);
	expect(JSON.stringify(result.content)).not.toContain("臆测结果");
	const deltas = events.filter(event => event.type === "toolcall_delta").map(event => event.delta).join("");
	expect(JSON.parse(deltas)).toEqual({ code: "value='😀\\n原文'\nvalue\n" });
});

it("结束标记同一行的后缀不阻止提交，也不进入源码或重放历史", async () => {
	const stream = await codeactStream(provider("说明\n<execute>\nvalue=42\nvalue\n</execute> trailing metadata\nshould_not_run()"))(model, context());
	for await (const _event of stream) { /* 排空流。 */ }
	const result = await stream.result();
	expect(result.stopReason).toBe("toolUse");
	expect(result.content.find(part => part.type === "toolCall")).toMatchObject({ arguments: { code: "value=42\nvalue\n" } });
	const history = context(); history.messages.push(result);
	const replay = codeactTranscript(history).context.messages.at(-1);
	if (replay?.role !== "assistant") throw new Error("fixture");
	expect(replay.content.filter(part => part.type === "text").map(part => part.text).join("")).toBe("说明\n<execute>\nvalue=42\nvalue\n</execute>");
	expect(JSON.stringify(result)).not.toContain("trailing metadata");
	expect(JSON.stringify(result)).not.toContain("should_not_run");
});

it.each(["length", "aborted"] as const)("闭合块也不掩盖供应商失败终态：%s", async reason => {
	const stream = await codeactStream(provider("<execute>\nchange()\n</execute> trailing metadata", reason))(model, context());
	for await (const _event of stream) { /* 排空流。 */ }
	expect((await stream.result()).stopReason).toBe(reason);
});

it("未闭合的输出超限保留 length 终态，不伪装成正常工具提交", async () => {
	const stream = await codeactStream(provider("<execute>\nchange()", "length"))(model, context());
	for await (const _event of stream) { /* 排空流。 */ }
	expect((await stream.result()).stopReason).toBe("length");
});

it("未闭合块不执行；禁用 CodeAct 时仅作为普通文字显示", async () => {
	const incomplete = await codeactStream(provider("<execute>\nchange()"))(model, context());
	for await (const _event of incomplete) { /* 排空流。 */ }
	expect(await incomplete.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("未闭合") });
	const disabled = await codeactStream(provider("<execute>\nchange()\n</execute>"))(model, context(false));
	for await (const _event of disabled) { /* 排空流。 */ }
	expect((await disabled.result()).content.some(part => part.type === "toolCall")).toBe(false);
});

it("父级取消会终止供应商流，未完成块不被补成可执行代码", async () => {
	const controller = new AbortController();
	let providerAborted = false;
	const pending: StreamFn = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "text", text: "<execute>\nchange()" });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "<execute>\nchange()", partial });
		options?.signal?.addEventListener("abort", () => {
			providerAborted = true;
			partial.stopReason = "aborted";
			stream.push({ type: "error", reason: "aborted", error: partial }); stream.end();
		}, { once: true });
		return stream;
	};
	const stream = await codeactStream(pending)(model, context(), { signal: controller.signal });
	for await (const event of stream) if (event.type === "toolcall_start") controller.abort();
	expect(providerAborted).toBe(true);
	const result = await stream.result();
	expect(result.stopReason).toBe("aborted");
	const history = context(); history.messages.push(result);
	expect(JSON.stringify(codeactTranscript(history).context.messages)).toContain("execute_not_run");
});

it.each([true, false])("传输不接受未请求的原生工具调用，包含仅终态返回：%s", async updates => {
	const native: StreamFn = () => {
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "toolCall", id: "fixture", name: "codemode", arguments: { code: "change()" } });
		if (updates) stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		stream.push({ type: "done", reason: "toolUse", message: partial }); stream.end();
		return stream;
	};
	const stream = await codeactStream(native)(model, context());
	for await (const _event of stream) { /* 排空流。 */ }
	expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("原生工具调用") });
});

it("供应商只在 text_end 补齐正文时仍按完整块解析", async () => {
	const endOnly: StreamFn = () => {
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "text", text: "<execute>\n42\n</execute>" });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: "<execute>\n42\n</execute>", partial });
		stream.push({ type: "done", reason: "stop", message: partial }); stream.end();
		return stream;
	};
	const stream = await codeactStream(endOnly)(model, context());
	for await (const _event of stream) { /* 排空流。 */ }
	const result = await stream.result();
	expect(result.stopReason).toBe("toolUse");
	expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: { code: "42\n" } });
});

it("正文终态更改流式源码时拒绝执行，不能靠闭合标记提交另一份代码", async () => {
	const inconsistent: StreamFn = () => {
		const stream = createAssistantMessageEventStream(), partial = message();
		stream.push({ type: "start", partial });
		partial.content.push({ type: "text", text: "different()" });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "<execute>\nchange()\n</execute>\n", partial });
		stream.push({ type: "text_end", contentIndex: 0, content: "different()", partial });
		stream.push({ type: "done", reason: "stop", message: partial }); stream.end();
		return stream;
	};
	const stream = await codeactStream(inconsistent)(model, context());
	for await (const _event of stream) { /* 排空流。 */ }
	expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("不一致") });
});

it("历史只在 API 边界转为文本；原始图片与会话记录不变", () => {
	const original = context();
	const assistant = message();
	assistant.content = [{ type: "toolCall", id: "fixture", name: "codemode", arguments: { code: "value=42\nvalue" } }];
	original.messages.push(assistant, { role: "toolResult", toolCallId: "fixture", toolName: "codemode", content: [{ type: "text", text: "原始结果" }, { type: "image", data: "SYNTHETIC_IMAGE", mimeType: "image/png" }], isError: false, timestamp: 2 });
	const converted = codeactTranscript(original).context;
	expect(getCurrentTools(converted.messages)).toEqual([]);
	expect(converted.messages.some(item => item.role === "toolResult")).toBe(false);
	expect(JSON.stringify(converted.messages)).toContain("<execute>\\nvalue=42\\nvalue\\n</execute>");
	expect(converted.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("execute_result status=\"ok\"") }, { type: "image", data: "SYNTHETIC_IMAGE", mimeType: "image/png" }] });
	expect(assistant.content[0]?.type).toBe("toolCall");
	expect(getCurrentTools(original.messages)).toHaveLength(1);
});
