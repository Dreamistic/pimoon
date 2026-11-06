import { expect, it } from "vitest";
import { aggregateTelemetry } from "../../../src/harness/telemetry-report/aggregate.ts";
import type { CallRecord, RunRecord } from "../../../src/harness/telemetry/types.ts";

const at = "2026-11-04T00:00:00Z";
const run: RunRecord = { type: "run", run_id: "r", session_id: "s", reason: "startup", cwd: "/fixture", at };
const call = (call_index: number, tool: string, extra: Partial<CallRecord> = {}): CallRecord => ({
	type: "call", run_id: "r", at, started_at: at, ended_at: at, call_id: String(call_index), call_index, tool, status: "success", ...extra,
});
const report = (calls: CallRecord[]) => aggregateTelemetry([run, ...calls], { generatedAt: at, inputFiles: [], invalidLines: 0, query: {} });

it("父子调用不混算成功率，部分失败和超时独立归类，未知终态不算成功", () => {
	const value = report([
		call(0, "codeact", { fields: { outcome: "success", metrics_complete: true, host_ms: 10, python_ms: 8, bridge_wait_ms: 6, state_reused: false } }),
		call(1, "codeact", { fields: { outcome: "tool_partial_failure", metrics_complete: true, internal_tool_failures: 1, model_returned_text_chars: 80, fs_open_read_attempts: 2 } }),
		call(2, "codeact", { status: "error", fields: { outcome: "timeout", metrics_complete: false, host_ms: 100, error_type: "Error", state_lost: true } }),
		call(3, "codeact"),
		call(4, "grep", { parent_call_id: "0", fields: { searched_file_count: 10, returned_match_count: 3 } }),
		call(5, "read", { parent_call_id: "1", status: "error" }),
	]);
	expect(value.execution.host).toEqual({ calls: 2, error_rate: { numerator: 1, samples: 2, value: 0.5 } });
	expect(value.execution.codeact).toMatchObject({
		calls: 4, metrics_samples: 2, clean_success_rate: { numerator: 1, samples: 3, value: 1 / 3 },
		outcomes: { success: 1, tool_partial_failure: 1, timeout: 1, unknown: 1 }, error_types: { Error: 1 },
		timing: { host_ms: { samples: 2, mean: 55 }, python_active_ms: { samples: 1, mean: 2 } },
		output: { returned: { samples: 1, total: 80 } }, native: { file_reads: { samples: 1, total: 2 } },
		state: { reused: { numerator: 0, samples: 1, value: 0 }, lost: { numerator: 1, samples: 1, value: 1 } },
	});
	expect(value.tools.find(tool => tool.tool === "grep")?.work).toMatchObject({ searched_file_count: { samples: 1, mean: 10 }, returned_match_count: { samples: 1, mean: 3 } });
	expect(value.candidate_ranking.producer_calls).toBe(0);
});

it("批处理汇总、原生操作和输出层次独立，历史缺失值没有伪造分布", () => {
	const value = report([call(0, "codeact", { fields: { batch_calls: 1, batch_jobs: 4, batch_completed: 4, batch_failures: 1, batch_peak_concurrency: 2,
		fs_open_read_attempts: 2, output_chars: 1000, model_returned_text_chars: 100, display_truncated: true, output_complete: false } }), call(1, "codeact")]).execution.codeact;
	expect(value.batch).toMatchObject({ calls: { samples: 1, total: 1 }, jobs: { samples: 1, total: 4 }, failures: { samples: 1, total: 1 }, peak_concurrency: { samples: 1, mean: 2 } });
	expect(value.native.file_reads).toEqual({ samples: 1, total: 2 });
	expect(value.display_truncated).toEqual({ numerator: 1, samples: 1, value: 1 });
	expect(value.retention_incomplete).toEqual({ numerator: 1, samples: 1, value: 1 });
	expect(value.timing.host_ms).toEqual({ samples: 0 });
	expect(value.clean_success_rate).toEqual({ numerator: 0, samples: 0 });
});
