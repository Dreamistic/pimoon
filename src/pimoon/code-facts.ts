import { isRecord } from "../harness/telemetry/projection.ts";
import type { TelemetryFacts } from "../harness/telemetry/types.ts";

/** 只投影已知计数；运行时详情中的正文、路径和错误文本不进入工具遥测。 */
export function codeFacts(details: unknown): TelemetryFacts {
	if (!isRecord(details) || !isRecord(details.metrics)) return {};
	const metrics = details.metrics;
	const fields: NonNullable<TelemetryFacts["fields"]> = {};
	for (const key of ["outcome", "metrics_complete", "host_ms", "python_ms", "compile_ms", "bridge_wait_ms",
		"internal_tool_calls", "internal_tool_failures", "internal_output_text_chars", "batch_calls", "tool_failure_count",
		"output_chars", "retained_output_chars", "displayed_output_chars", "model_returned_text_chars",
		"display_truncated", "output_complete", "explicit_observations", "observation_input_rows", "observation_shown_rows",
		"observation_readbacks", "observation_readback_errors", "compile_cache_hit"]) {
		const value = metrics[key];
		if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
			|| key === "outcome" && typeof value === "string") fields[key] = value;
	}
	return { fields };
}
