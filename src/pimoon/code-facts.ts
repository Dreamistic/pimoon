import { isRecord } from "../harness/telemetry/projection.ts";
import type { Fields, TelemetryFacts } from "../harness/telemetry/types.ts";

const outcomes = new Set(["success", "tool_partial_failure", "python_error", "timeout", "cancelled", "startup_error", "runtime_crash", "runtime_error", "confirmation_rejected", "confirmation_unavailable", "confirmation_invalidated"]);
const errorTypes = new Set(["SyntaxError", "IndentationError", "NameError", "TypeError", "ValueError", "KeyError", "IndexError", "AttributeError",
	"ToolError", "ParallelError", "FileNotFoundError", "PermissionError", "OSError", "RuntimeError", "ImportError", "ModuleNotFoundError", "AssertionError", "ZeroDivisionError", "Error"]);

/** 只投影白名单计数与分类；正文、路径、用户异常类名和原生访问轨迹不进入工具遥测。 */
export function codeFacts(details: unknown): TelemetryFacts {
	if (!isRecord(details) || !isRecord(details.metrics)) return {};
	const metrics = details.metrics;
	const fields: Fields = {};
	for (const key of ["execution_metrics_version", "host_ms", "python_ms", "compile_ms", "bridge_wait_ms", "startup_wait_ms",
		"internal_tool_calls", "internal_tool_failures", "internal_output_text_chars", "batch_calls", "batch_jobs", "batch_completed", "batch_failures", "batch_peak_concurrency",
		"output_chars", "retained_output_chars", "displayed_output_chars", "model_returned_text_chars", "stdout_chars", "stderr_chars", "auto_results", "expression_results",
		"tool_failure_count",
		"explicit_observations", "observation_input_rows", "observation_shown_rows", "observation_readbacks", "observation_readback_errors"]) {
		const value = metrics[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) fields[key] = value;
	}
	for (const key of ["executed", "metrics_complete", "display_truncated", "output_complete", "compile_cache_hit", "state_reused", "state_lost", "runtime_reinitialized"]) {
		if (typeof metrics[key] === "boolean") fields[key] = metrics[key];
	}
	if (typeof metrics.outcome === "string" && outcomes.has(metrics.outcome)) fields.outcome = metrics.outcome;
	if (typeof metrics.error_type === "string") fields.error_type = errorTypes.has(metrics.error_type) ? metrics.error_type : "OtherError";
	if (metrics.filesystem_metrics_version === 1 && isRecord(metrics.filesystem_audit_attempts)) {
		const attempts = metrics.filesystem_audit_attempts;
		const count = (key: string) => typeof attempts[key] === "number" && Number.isFinite(attempts[key]) && attempts[key] >= 0 ? attempts[key] : 0;
		fields.fs_open_read_attempts = count("open_read");
		fields.fs_open_write_attempts = count("open_write");
		fields.fs_list_attempts = count("os.listdir") + count("os.scandir");
		fields.fs_mutation_attempts = ["os.remove", "os.rmdir", "os.mkdir", "os.rename", "os.replace", "os.chdir"].reduce((sum, key) => sum + count(key), 0);
	}
	return { fields };
}
