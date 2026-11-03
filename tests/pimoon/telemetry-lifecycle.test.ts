import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { closeTelemetry, flushTelemetry, record, telemetryDirectory, telemetryStats } from "../../src/pimoon/telemetry.ts";

it("后台结束事件与最终检查点按序落盘，并发关闭只结算一次", async () => {
	record("synthetic_lifecycle", { session_id: "fixture-session", agent_run_id: "fixture-agent" });
	await flushTelemetry();
	expect(telemetryStats().closed).toBe(false);
	await Promise.all([closeTelemetry(), closeTelemetry()]);
	const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
	expect(files).toHaveLength(1);
	const file = path.join(telemetryDirectory, files[0] ?? "missing");
	const events: unknown[] = (await fs.readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
	expect(events).toMatchObject([
		{ type: "backend_start", schema: 2, seq: 1, app_version: expect.any(String) },
		{ type: "synthetic_lifecycle", seq: 2, session_id: "fixture-session", agent_run_id: "fixture-agent" },
		{ type: "backend_end", seq: 3, telemetry_complete: true },
	]);
	expect(JSON.parse(await fs.readFile(`${file}.status.json`, "utf8"))).toMatchObject({ complete: true, closed: true, acceptedRecords: 3, writtenRecords: 3, droppedRecords: 0, pendingBytes: 0 });
});
