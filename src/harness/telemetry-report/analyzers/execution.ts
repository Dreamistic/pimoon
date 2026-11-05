import type { CallRecord } from "../../telemetry/types.ts";
import { frequency, numericSummary } from "../shared.ts";

/** 执行量包含嵌套调用；候选曝光与采用仍由模型直接调用分析。 */
export function analyzeExecution(calls: readonly CallRecord[]) {
	const code = calls.filter(call => (call.tool === "codeact" || call.tool === "execute"));
	const numbers = (key: string) => code.flatMap(call => {
		const value = call.fields?.[key];
		return typeof value === "number" ? [value] : [];
	});
	const count = (key: string, value: boolean) => code.filter(call => call.fields?.[key] === value).length;
	return {
		direct_calls: calls.filter(call => call.parent_call_id === undefined).length,
		nested_calls: calls.filter(call => call.parent_call_id !== undefined).length,
		by_tool: Object.fromEntries([...new Set(calls.map(call => call.tool))].sort().map(tool => [tool, {
			direct: calls.filter(call => call.tool === tool && call.parent_call_id === undefined).length,
			nested: calls.filter(call => call.tool === tool && call.parent_call_id !== undefined).length,
		}])),
		codeact: {
			calls: code.length,
			metrics_samples: count("metrics_complete", true),
			outcomes: frequency(code.map(call => {
				const outcome = call.fields?.["outcome"];
				return typeof outcome === "string" ? outcome : "unknown";
			})),
			internal_calls: numericSummary(numbers("internal_tool_calls")),
			internal_output_chars: numericSummary(numbers("internal_output_text_chars")),
			returned_chars: numericSummary(numbers("model_returned_text_chars")),
			bridge_wait_ms: numericSummary(numbers("bridge_wait_ms")),
			batch_calls: numbers("batch_calls").reduce((sum, value) => sum + value, 0),
			display_truncated_calls: count("display_truncated", true),
			retention_incomplete_calls: count("output_complete", false),
		},
	};
}
