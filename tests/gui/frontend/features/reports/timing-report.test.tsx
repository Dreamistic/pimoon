import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TimingReport } from "../../../../../src/gui/frontend/features/reports/timing-report.tsx";
import { createLiveTelemetryReport } from "../../../../../src/harness/telemetry-report/live.ts";

it("报告区分审批、进程与搜索阶段；旧样本缺失及未结束审批不进入完整耗时分布", () => {
	const at = "2026-11-04T00:00:00Z";
	const call = { type: "call" as const, run_id: "run", at, started_at: at, ended_at: at, status: "success" as const };
	const report = createLiveTelemetryReport({ enabled: true, pending_calls: 0, records: [
		{ type: "run", run_id: "run", session_id: "session", at, reason: "startup", cwd: "/fixture" },
		{ ...call, call_id: "code", call_index: 0, tool: "codeact", fields: { wall_ms: 130000 } },
		{ ...call, call_id: "process", parent_call_id: "code", call_index: 1, tool: "process_run", fields: { wall_ms: 122000, approval_wait_ms: 96000, approval_wait_complete: true, process_duration_ms: 25500 } },
		{ ...call, call_id: "incomplete", call_index: 2, tool: "process_run", fields: { wall_ms: 12000, approval_wait_ms: 11000, approval_wait_complete: false } },
		{ ...call, call_id: "old", call_index: 3, tool: "process_run", duration_ms: 100 },
		{ ...call, call_id: "grep", parent_call_id: "code", call_index: 4, tool: "grep", fields: { inventory_ms: 50, scan_ms: 10, analysis_ms: 2, regionize_ms: 5, rank_pack_ms: 3, search_total_ms: 70 } },
	] });
	const process = report.timing?.tools.find(row => row.tool === "process_run");
	expect(process).toMatchObject({ wall_ms: { samples: 2 }, approval_wait_ms: { samples: 1, p50: 96000 }, process_duration_ms: { samples: 1, p50: 25500 }, incomplete_approvals: 1 });
	expect(report.timing?.tools.some(row => row.tool === "codeact")).toBe(false);
	const html = renderToStaticMarkup(createElement(TimingReport, { value: report.timing }));
	for (const text of ["等待审批", "96 s", "程序实际执行", "25.5 s", "目录发现", "50 ms", "审批计时未完整结束", "不相加"]) expect(html).toContain(text);
});

it("旧会话没有阶段数据时不伪装成零等待", () => {
	const report = createLiveTelemetryReport({ enabled: true, pending_calls: 0, records: [] });
	const html = renderToStaticMarkup(createElement(TimingReport, { value: report.timing }));
	expect(html).toContain("历史缺失值不补零");
	expect(html).not.toContain("0 ms");
});
