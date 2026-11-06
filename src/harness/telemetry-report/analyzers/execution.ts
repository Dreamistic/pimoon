import type { CallRecord } from "../../telemetry/types.ts";
import { frequency, numericSummary, rateSummary } from "../shared.ts";

/** 执行单元、宿主调用和原生操作分层统计，不把父子调用相加当作成功率。 */
export function analyzeExecution(calls: readonly CallRecord[]) {
	const code = calls.filter(call => (call.tool === "codeact" || call.tool === "execute"));
	const host = calls.filter(call => call.tool !== "codeact" && call.tool !== "execute");
	const numbers = (key: string) => code.flatMap(call => numeric(call, key) ?? []);
	const summary = (key: string) => numericSummary(numbers(key));
	const total = (key: string) => {
		const values = numbers(key);
		return { samples: values.length, total: values.reduce((sum, value) => sum + value, 0) };
	};
	const count = (key: string, value: boolean) => code.filter(call => call.fields?.[key] === value).length;
	const booleanRate = (key: string, value = true) => rateSummary(count(key, value), code.filter(call => typeof call.fields?.[key] === "boolean").length);
	const outcomes = code.map(call => {
		const value = call.fields?.["outcome"];
		return typeof value === "string" ? value : "unknown";
	});
	return {
		direct_calls: calls.filter(call => call.parent_call_id === undefined).length,
		nested_calls: calls.filter(call => call.parent_call_id !== undefined).length,
		by_tool: Object.fromEntries([...new Set(calls.map(call => call.tool))].sort().map(tool => [tool, {
			direct: calls.filter(call => call.tool === tool && call.parent_call_id === undefined).length,
			nested: calls.filter(call => call.tool === tool && call.parent_call_id !== undefined).length,
		}])),
		host: {
			calls: host.length,
			error_rate: rateSummary(host.filter(call => call.status === "error").length, host.length),
		},
		codeact: {
			calls: code.length,
			metrics_samples: count("metrics_complete", true),
			outcomes: frequency(outcomes),
			clean_success_rate: rateSummary(outcomes.filter(value => value === "success").length, outcomes.filter(value => value !== "unknown").length),
			error_types: frequency(code.flatMap(call => typeof call.fields?.["error_type"] === "string" ? [call.fields["error_type"]] : [])),
			internal_calls: summary("internal_tool_calls"),
			internal_failures: total("internal_tool_failures"),
			internal_output_chars: summary("internal_output_text_chars"),
			returned_chars: summary("model_returned_text_chars"),
			bridge_wait_ms: summary("bridge_wait_ms"),
			timing: {
				host_ms: summary("host_ms"), startup_wait_ms: summary("startup_wait_ms"),
				python_ms: summary("python_ms"), compile_ms: summary("compile_ms"),
				// Python 墙钟包含桥接等待，不把二者相加；并发工具耗时也不能直接累加。
				python_active_ms: numericSummary(code.flatMap(call => {
					const python = numeric(call, "python_ms"), bridge = numeric(call, "bridge_wait_ms");
					return python !== undefined && bridge !== undefined && python >= bridge ? [python - bridge] : [];
				})),
			},
			batch: {
				calls: total("batch_calls"), jobs: total("batch_jobs"), completed: total("batch_completed"), failures: total("batch_failures"),
				peak_concurrency: summary("batch_peak_concurrency"),
			},
			output: {
				produced: total("output_chars"), retained: total("retained_output_chars"), displayed: total("displayed_output_chars"),
				returned: total("model_returned_text_chars"), internal: total("internal_output_text_chars"),
				stdout: total("stdout_chars"), stderr: total("stderr_chars"), auto_results: total("auto_results"), expressions: total("expression_results"),
			},
			native: {
				read_calls: total("native_read_calls_observed"), read_failures: total("native_read_failures"), read_chars: total("native_read_result_chars"), read_ms: summary("native_read_ms"),
				file_reads: total("fs_open_read_attempts"), file_writes: total("fs_open_write_attempts"), directory_lists: total("fs_list_attempts"), mutations: total("fs_mutation_attempts"),
			},
			state: { reused: booleanRate("state_reused"), lost: booleanRate("state_lost"), reinitialized: booleanRate("runtime_reinitialized") },
			display_truncated: booleanRate("display_truncated"), retention_incomplete: booleanRate("output_complete", false),
		},
	};
}

function numeric(call: CallRecord, key: string): number | undefined {
	const value = call.fields?.[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
