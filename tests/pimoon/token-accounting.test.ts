import { expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { estimateRequestTokens, estimateResponseTokens, summarizeTokenAccounting, textTokens } from "../../src/pimoon/token-accounting.ts";
import { responseUsageStatus } from "../../src/pimoon/usage-status.ts";
import { codeactInstructions } from "../../src/pimoon/codeact/prompt.ts";
import type { CodeActMessage } from "../../src/pimoon/codeact/types.ts";

function message(): AssistantMessage {
	return { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "fixture", timestamp: 1, stopReason: "stop",
		content: [{ type: "text", text: "完成" }],
		usage: { input: 10, output: 5, cacheRead: 5, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

it("原生工具声明、历史调用和结果分别计量，重复输入不会被误去重", () => {
	const payload = { instructions: "fixture", tools: [{ type: "function", name: "read", parameters: { type: "object" } }], input: [
		{ type: "function_call", name: "read", arguments: '{"path":"a.txt"}' },
		{ type: "function_call_output", output: "原始结果😀" },
	] };
	const input = estimateRequestTokens(payload);
	if (!input) throw new Error("fixture request estimate missing");
	expect(input).toMatchObject({ method: "o200k_base", images: 0, encrypted_items: 0 });
	expect(input?.tool_definitions).toBeGreaterThan(0);
	expect(input?.tool_calls).toBeGreaterThan(0);
	expect(input?.tool_results).toBeGreaterThan(0);
	const output = estimateResponseTokens(message());
	const summary = summarizeTokenAccounting([{ input, output, usage: message().usage, usage_status: "complete" }, { input, output, usage: message().usage, usage_status: "complete" }]);
	expect(summary.provider_total_tokens).toBe(40);
	expect(summary.estimate.input_tokens).toBe((input?.input ?? 0) * 2);
	expect(summary.estimate.tool_result_input_tokens).toBe((input?.tool_results ?? 0) * 2);
});

it.each(["additional_tools", "tool_search_output"])("Responses 的内联工具声明也计入工具说明：%s", type => {
	const declaration = { type, role: "developer", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] };
	const input = estimateRequestTokens({ instructions: "fixture", input: [declaration] });
	expect(input?.tool_definitions).toBe(textTokens(JSON.stringify(declaration)));
	expect(input?.tool_calls).toBe(0);
	expect(input?.tool_results).toBe(0);
});

it("CodeAct 说明和目录在输入侧计数，结果只计实际回填内容，不扫描内部 I/O", () => {
	const code = '<execute desc="读取">\nvalue=read(path="a.txt")\nlen(value)\n</execute>';
	const result = '<execute_result status="ok">\nok\n42\n</execute_result>';
	const input = estimateRequestTokens({ instructions: `base\n${codeactInstructions}\nFunctions:\nread(path:str)`, input: [
		{ role: "assistant", content: [{ type: "output_text", text: code }] },
		{ role: "user", content: [{ type: "input_text", text: result }] },
	], tools: [] });
	expect(input?.tool_definitions).toBeGreaterThan(100);
	expect(input?.tool_calls).toBe(textTokens(code));
	expect(input?.tool_results).toBe(textTokens(result));
	const output = estimateResponseTokens({ ...message(), content: [{ type: "text", text: 'value=read(path="a.txt")\nlen(value)\n' }], codeactContent: [{ type: "text", text: code }] });
	expect(output.visible_output).toBe(textTokens(code));
	expect(output.tool_calls).toBe(textTokens(code));
	expect(JSON.stringify(input)).not.toContain("a.txt");
});

it("截流、失败和没有终态的请求都不能把已报告量冒充总量", () => {
	const partial: CodeActMessage = { ...message(), codeactStop: { sequence: "</execute>", usage: "partial" } };
	expect(responseUsageStatus(partial)).toBe("partial");
	expect(responseUsageStatus({ ...message(), stopReason: "aborted" })).toBe("partial");
	expect(responseUsageStatus({ ...message(), usage: { ...message().usage, totalTokens: 0 } })).toBe("unavailable");
	const input = estimateRequestTokens({ input: [{ role: "user", content: "fixture" }] });
	if (!input) throw new Error("fixture request estimate missing");
	const output = estimateResponseTokens(partial);
	const summary = summarizeTokenAccounting([{ input, output, usage: partial.usage, usage_status: "partial" }, { input }]);
	expect(summary).toMatchObject({ requests: 2, partial_usage_requests: 1, unknown_usage_requests: 1, provider_reported_tokens: 20, provider_total_tokens: null });
	expect(summary.estimate.visible_total_tokens).toBeNull();
	expect(summary.estimate.tool_tokens).toBeNull();
});

it("图片和加密内容不按 base64 字符冒充 token，未知请求格式不补零", () => {
	const payload = (data: string) => ({ input: [{ role: "user", content: [{ type: "input_image", image_url: data }] }, { type: "reasoning", encrypted_content: data }] });
	const short = estimateRequestTokens(payload("private")), long = estimateRequestTokens(payload("private".repeat(10000)));
	expect(short).toMatchObject({ images: 1, encrypted_items: 1 });
	expect(long?.input).toBe(short?.input);
	expect(estimateRequestTokens({ secret: "private" })).toBeUndefined();
	expect(summarizeTokenAccounting([]).provider_total_tokens).toBeNull();
	expect(JSON.stringify(long)).not.toContain("private");
});

it("普通说明和 fenced 示例不计成执行调用，Unicode 和特殊 token 字面量可计数", () => {
	for (const text of ["这里提到了 execute。", "```python\n<execute>\n42\n</execute>\n```", "<execute>\n未闭合"]) {
		expect(estimateResponseTokens({ ...message(), content: [{ type: "text", text }] }).tool_calls).toBe(0);
	}
	expect(textTokens("😀中文<|endoftext|>")).toBeGreaterThan(0);
});
