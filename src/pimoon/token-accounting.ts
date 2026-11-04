import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CodeActParser } from "./codeact/parser.ts";
import { codeactInstructions } from "./codeact/prompt.ts";
import type { CodeActMessage } from "./codeact/types.ts";

const options = { disallowedSpecial: new Set<string>() };
export const textTokens = (text: string): number => countTokens(text, options);
const jsonTokens = (value: unknown): number => textTokens(JSON.stringify(value) ?? "");
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface RequestTokenEstimate {
	method: "o200k_base";
	input: number;
	tool_definitions: number;
	tool_calls: number;
	tool_results: number;
	images: number;
	encrypted_items: number;
	elapsed_ms: number;
}
export interface ResponseTokenEstimate {
	method: "o200k_base";
	visible_output: number;
	tool_calls: number;
	elapsed_ms: number;
}
export type UsageStatus = "complete" | "partial" | "unavailable";
export interface TokenAccountingRecord {
	input?: RequestTokenEstimate;
	output?: ResponseTokenEstimate;
	usage?: AssistantMessage["usage"];
	usage_status?: UsageStatus;
}

/** 仅计可见载荷；图片、加密思考和供应商隐藏协议不假装能本地计量。 */
export function estimateRequestTokens(payload: unknown): RequestTokenEstimate | undefined {
	if (!record(payload)) return;
	const input = Array.isArray(payload.input) ? payload.input : Array.isArray(payload.messages) ? payload.messages : undefined;
	if (!input) return;
	const started = performance.now();
	let images = 0, encrypted = 0;
	const visible = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(visible);
		if (!record(value)) return value;
		if (["input_image", "image_url", "image"].includes(String(value.type))) { images++; return { type: "image" }; }
		return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
			if (key === "encrypted_content" || key === "thinkingSignature") { encrypted++; return []; }
			return [[key, visible(item)]];
		}));
	};
	const items = input.map(visible);
	const instructions = typeof payload.instructions === "string" ? payload.instructions : "";
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const protocol = instructions.indexOf(codeactInstructions);
	let calls = 0, results = 0, inlineDefinitions = 0;
	for (const item of items) {
		if (!record(item)) continue;
		if (item.type === "additional_tools" || item.type === "tool_search_output") inlineDefinitions += jsonTokens(item);
		else if (item.type === "function_call" || item.type === "custom_tool_call") calls += jsonTokens(item);
		else if (item.type === "function_call_output" || item.type === "custom_tool_call_output" || item.role === "tool") results += jsonTokens(item);
		else {
			const parts = typeof item.content === "string" ? [item.content] : Array.isArray(item.content)
				? item.content.flatMap(part => record(part) && typeof part.text === "string" ? [part.text] : []) : [];
			for (const text of parts) {
				if (item.role === "assistant") calls += executionTokens(text);
				if (item.role === "user" && text.startsWith('<execute_result status="')) results += textTokens(text);
			}
			if (Array.isArray(item.tool_calls)) calls += jsonTokens(item.tool_calls);
		}
	}
	return { method: "o200k_base", input: jsonTokens({ instructions, input: items, tools }),
		tool_definitions: inlineDefinitions + (tools.length ? jsonTokens(tools) : 0) + (protocol < 0 ? 0 : textTokens(instructions.slice(protocol))),
		tool_calls: calls, tool_results: results, images, encrypted_items: encrypted, elapsed_ms: performance.now() - started };
}

/** 使用原始 CodeAct 回放文本，保留执行标记；不把内部函数结果当作模型曝光。 */
export function estimateResponseTokens(message: CodeActMessage): ResponseTokenEstimate {
	const started = performance.now();
	const content = message.codeactContent ?? message.content;
	let output = 0, calls = 0;
	for (const part of content) {
		if (part.type === "toolCall") {
			const tokens = jsonTokens({ name: part.name, arguments: part.arguments });
			output += tokens; calls += tokens;
		} else if (part.type === "text" || part.type === "thinking") {
			const text = part.type === "text" ? part.text : part.redacted ? "" : part.thinking;
			output += textTokens(text);
			if (part.type === "text") calls += executionTokens(text);
		}
	}
	return { method: "o200k_base", visible_output: output, tool_calls: calls, elapsed_ms: performance.now() - started };
}

export function responseUsageStatus(message: CodeActMessage): UsageStatus {
	if (message.codeactStop) return message.codeactStop.usage;
	if (!Number.isFinite(message.usage.totalTokens) || message.usage.totalTokens <= 0) return "unavailable";
	return ["error", "aborted", "pending"].includes(message.stopReason) ? "partial" : "complete";
}

/** 真实总量只在每次请求均有完整 usage 时存在；估算与供应商数字绝不混加。 */
export function summarizeTokenAccounting(records: readonly TokenAccountingRecord[]) {
	const status = (item: TokenAccountingRecord): UsageStatus => item.usage && Number.isFinite(item.usage.totalTokens) && item.usage.totalTokens > 0
		? item.usage_status ?? "unavailable" : "unavailable";
	const complete = records.filter(item => status(item) === "complete").length;
	const measured = records.filter(item => item.input && item.output);
	const sum = (get: (item: TokenAccountingRecord) => number) => records.reduce((total, item) => total + get(item), 0);
	const input = sum(item => item.input?.input ?? 0), output = sum(item => item.output?.visible_output ?? 0);
	const definitions = sum(item => item.input?.tool_definitions ?? 0);
	const replayedCalls = sum(item => item.input?.tool_calls ?? 0), results = sum(item => item.input?.tool_results ?? 0);
	const calls = sum(item => item.output?.tool_calls ?? 0);
	const reported = sum(item => item.usage && Number.isFinite(item.usage.totalTokens) && item.usage.totalTokens > 0 ? item.usage.totalTokens : 0);
	return {
		requests: records.length, complete_usage_requests: complete,
		partial_usage_requests: records.filter(item => status(item) === "partial").length,
		unknown_usage_requests: records.filter(item => status(item) === "unavailable").length,
		provider_reported_tokens: reported,
		provider_total_tokens: records.length > 0 && complete === records.length ? reported : null,
		estimate: { method: "o200k_base", measured_requests: measured.length,
			visible_total_tokens: records.length > 0 && measured.length === records.length ? input + output : null,
			input_tokens: input, visible_output_tokens: output,
			tool_definition_input_tokens: definitions, tool_call_input_tokens: replayedCalls,
			tool_result_input_tokens: results, tool_call_output_tokens: calls,
			tool_tokens: records.length > 0 && measured.length === records.length ? definitions + replayedCalls + results + calls : null,
			images: sum(item => item.input?.images ?? 0), encrypted_items: sum(item => item.input?.encrypted_items ?? 0),
			accounting_ms: sum(item => (item.input?.elapsed_ms ?? 0) + (item.output?.elapsed_ms ?? 0)),
		},
	};
}

function executionTokens(text: string): number {
	try {
		const parser = new CodeActParser();
		const chunks = parser.feed(text);
		if (!parser.closed) return 0;
		const code = chunks.flatMap(chunk => chunk.type === "code" ? [chunk.text] : []).join("");
		const start = text.lastIndexOf("<execute", parser.consumed - "</execute>".length - code.length);
		return start < 0 ? 0 : textTokens(text.slice(start, parser.consumed));
	} catch { return 0; }
}
