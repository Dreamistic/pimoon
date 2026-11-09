import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { approvalDiagnostic } from "../../src/harness/approval/diagnostics.ts";
import { flushTelemetry, telemetryDirectory } from "../../src/pimoon/telemetry.ts";

it("审批诊断写入现有后台JSONL，保留关联字段与决定", async () => {
	approvalDiagnostic("diagnostic-fixture", "call-fixture", "request-hash", "process_run",
		{ phase: "advisor_start", model: "openai-codex/gpt-6.1-sol",
			contextCount: 2, evidenceCount: 3, discussionCount: 0 });
	approvalDiagnostic("diagnostic-fixture", "call-fixture", "request-hash", "process_run",
		{ phase: "resolved", outcome: "approved", actor: "advisor", scope: "once", elapsedMs: 12 });
	await flushTelemetry();
	const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
	const rows: Record<string, unknown>[] = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8"))))
		.flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)))
		.filter(row => row.session_id === "diagnostic-fixture" && row.type === "approval_diagnostic");
	expect(rows).toHaveLength(2);
	expect(rows[0]).toMatchObject({ tool_call_id: "call-fixture", request_hash: "request-hash", phase: "advisor_start", evidenceCount: 3 });
	expect(rows[1]).toMatchObject({ phase: "resolved", actor: "advisor", scope: "once" });
	for (const row of rows) for (const key of ["argv", "content", "prompt", "feedback"]) expect(row).not.toHaveProperty(key);
});
