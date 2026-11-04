import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { APPROVAL_STATUS_CHANNEL } from "../../../src/harness/approval/events.ts";
import { registerTelemetry, type TelemetryService } from "../../../src/harness/telemetry/service.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("telemetry-timing-");
afterEach(() => vi.restoreAllMocks());

it("审批状态按调用关联，拒绝与中断不伪造进程执行，重复事件不重复计时", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const events = createEventBus();
	let service: TelemetryService | undefined;
	const { handlers } = registerExtension(pi => { service = registerTelemetry(pi); }, {
		events, getAllTools: () => [], getThinkingLevel: () => "off",
	});
	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
		cwd: temp.path, sessionManager: { getSessionId: () => "timing-session" }, ui: { notify() {} },
	});
	const start = (id: string) => handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: id, toolName: "process_run", args: {} }, { sessionManager: { getSessionId: () => "timing-session" } });
	const approval = (id: string) => events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId: id, toolName: "process_run" });
	const end = (id: string, executed: boolean) => handlers.get("tool_execution_end")?.({
		type: "tool_execution_end", toolCallId: id, toolName: "process_run", isError: !executed,
		...(executed ? { durationMs: 25 } : {}),
		result: { content: [{ type: "text", text: "PRIVATE_OUTPUT" }], ...(executed ? { details: { duration_ms: 24.5 } } : {}) },
	});
	try {
		await start("ok"); now = 10; approval("ok"); now = 15; approval("ok");
		events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId: 42 });
		now = 110; events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId: "ok", outcome: "approved" });
		now = 120; events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId: "ok", outcome: "approved" });
		now = 140; await end("ok", true);
		await start("cancelled"); now = 150; approval("cancelled"); now = 170; await end("cancelled", false);
		await start("no-approval"); now = 180; await end("no-approval", false);
		const calls = service?.snapshot().records.filter(record => record.type === "call");
		expect(calls?.[0]).toMatchObject({ duration_ms: 25, fields: { wall_ms: 140, approval_wait_ms: 100, approval_wait_complete: true, process_duration_ms: 24.5 } });
		expect(calls?.[1]).toMatchObject({ fields: { wall_ms: 30, approval_wait_ms: 20, approval_wait_complete: false } });
		expect(calls?.[1]).not.toHaveProperty("duration_ms");
		expect(calls?.[1]?.fields).not.toHaveProperty("process_duration_ms");
		expect(calls?.[2]?.fields).not.toHaveProperty("approval_wait_ms");
		expect(JSON.stringify(calls)).not.toContain("PRIVATE_OUTPUT");
	} finally { await service?.onSessionShutdown({ type: "session_shutdown", reason: "quit" }); }
});
