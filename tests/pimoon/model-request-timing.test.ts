import fs from "node:fs/promises";
import path from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { pimoonTelemetry, flushTelemetry, telemetryDirectory } from "../../src/pimoon/telemetry.ts";
import { APPROVAL_STATUS_CHANNEL } from "../../src/harness/approval/events.ts";
import { registerExtension } from "../helpers/extension.ts";
import { assistant } from "../gui/helpers/transcript-fixtures.ts";

it("合成错误不重复计模型时长，审批起止与实际进程时长写入后台遥测", async () => {
	const events = createEventBus();
	const { handlers } = registerExtension(pimoonTelemetry, { events });
	const ctx = { sessionManager: { getSessionId: () => "timing-fixture" }, model: { id: "fixture", provider: "fixture" } };
	await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "fixture" }, ctx);
	await handlers.get("before_provider_request")?.({ payload: { instructions: "PRIVATE_PROTOCOL", input: [{ role: "user", content: "PRIVATE_PROMPT" }] } }, ctx);
	await handlers.get("message_end")?.({ message: assistant([{ type: "text", text: "done" }]) }, ctx);
	await handlers.get("message_end")?.({ message: { ...assistant([]), stopReason: "error", errorMessage: "synthetic cancellation" } }, ctx);
	await handlers.get("before_provider_request")?.({ payload: { next: true } }, ctx);
	await handlers.get("message_end")?.({ message: assistant([]) }, ctx);
	await handlers.get("tool_execution_start")?.({ toolCallId: "process", toolName: "process_run", args: {} }, ctx);
	events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId: "process", toolName: "process_run" });
	events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId: "process", outcome: "approved" });
	await handlers.get("tool_execution_end")?.({ toolCallId: "process", toolName: "process_run", isError: false, durationMs: 20, result: { content: [], details: { duration_ms: 18 } } }, ctx);
	await flushTelemetry();
	const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
	const rows: Array<Record<string, unknown>> = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8"))))
		.flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
	expect(rows.filter(row => row["type"] === "model_end")).toHaveLength(2);
	expect(rows.find(row => row["type"] === "model_request")).toMatchObject({ token_estimate: { input: expect.any(Number), method: "o200k_base" } });
	expect(rows.filter(row => row["type"] === "model_end")).toEqual(expect.arrayContaining([expect.objectContaining({ token_estimate: expect.objectContaining({ visible_output: expect.any(Number) }) })]));
	expect(rows.find(row => row["type"] === "assistant_end")).not.toHaveProperty("token_estimate");
	expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
	expect(rows.filter(row => row["type"] === "assistant_end")).toMatchObject([{ elapsed_ms: null, stop_reason: "error" }]);
	expect(rows.filter(row => row["type"] === "approval_start")).toHaveLength(1);
	expect(rows.filter(row => row["type"] === "approval_end")).toMatchObject([{ outcome: "approved" }]);
	expect(rows.find(row => row["type"] === "tool_end")).toMatchObject({ execution_ms: 20, process_duration_ms: 18, approval_wait_complete: true, approval_wait_ms: expect.any(Number), wall_ms: expect.any(Number) });
	await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
});
