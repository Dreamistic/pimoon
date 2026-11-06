import { expect, it } from "vitest";
import { codeFacts } from "../../src/pimoon/code-facts.ts";
import { safeProject } from "../../src/harness/telemetry/projection.ts";

it("执行事实保留失败计数，过滤正文、轨迹、自定义异常名与无效数字", () => {
	const facts = codeFacts({ code: "PRIVATE_CODE", metrics: {
		outcome: "timeout", metrics_complete: false, error_type: "PRIVATE_EXCEPTION", host_ms: 100, state_lost: true,
		internal_tool_calls: 3, internal_tool_failures: 1, auto_results: 2,
		batch_jobs: 8, batch_completed: 8, batch_failures: 1, batch_peak_concurrency: 4,
		native_read_calls_observed: 130, native_read_failures: 2, native_read_trace: [{ target: "PRIVATE_PATH" }],
		filesystem_metrics_version: 1, filesystem_audit_attempts: { open: 9, open_read: 5, open_write: 4, "os.scandir": 3, "os.mkdir": 1, "PRIVATE_PATH": 1 },
		stdout_chars: 20, stderr_chars: -1, python_ms: Infinity, compile_ms: "wrong", output_chars: NaN, output: "PRIVATE_OUTPUT",
	} });
	expect(facts.fields).toMatchObject({ outcome: "timeout", metrics_complete: false, error_type: "OtherError", host_ms: 100, state_lost: true,
		internal_tool_calls: 3, internal_tool_failures: 1,
		fs_open_read_attempts: 5, fs_open_write_attempts: 4, fs_list_attempts: 3, fs_mutation_attempts: 1,
	});
	expect(JSON.stringify(facts)).not.toMatch(/PRIVATE|native_read|stderr_chars|python_ms|compile_ms|output_chars/);
	expect(safeProject(() => facts)).toEqual({ facts, limited: false });
});

it("旧指标不补造原生操作，未知分类不当作成功", () => {
	expect(codeFacts({ metrics: { filesystem_audit_attempts: { open: 2 }, outcome: "PRIVATE", error_type: "SyntaxError", python_ms: 2 } })).toEqual({ fields: { error_type: "SyntaxError", python_ms: 2 } });
	expect(codeFacts(undefined)).toEqual({});
});
