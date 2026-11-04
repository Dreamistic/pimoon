import type { CallRecord } from "../../telemetry/types.ts";
import { numericSummary } from "../shared.ts";

const searchStages = ["inventory_ms", "scan_ms", "analysis_ms", "regionize_ms", "rank_pack_ms", "search_total_ms"] as const;
export type SearchTimingStage = typeof searchStages[number];

/** 汇总真实观测区间，不把审批、执行或并行子调用相加。 */
export function analyzeTimings(calls: readonly CallRecord[]) {
	const host = calls.filter(call => call.tool !== "codeact");
	const grep = host.filter(call => call.tool === "grep");
	return {
		tools: [...new Set(host.map(call => call.tool))].sort().map(tool => {
			const selected = host.filter(call => call.tool === tool);
			return {
				tool,
				wall_ms: summarize(selected, "wall_ms"),
				approval_wait_ms: summarize(selected.filter(call => call.fields?.["approval_wait_complete"] === true), "approval_wait_ms"),
				incomplete_approvals: selected.filter(call => call.fields?.["approval_wait_complete"] === false).length,
				process_duration_ms: summarize(selected, "process_duration_ms"),
			};
		}).filter(row => row.wall_ms.samples > 0 || row.approval_wait_ms.samples > 0 || row.process_duration_ms.samples > 0 || row.incomplete_approvals > 0),
		search: searchStages.map(stage => ({ stage, ...summarize(grep, stage) })),
	};
}

function summarize(calls: readonly CallRecord[], field: string) {
	return numericSummary(calls.flatMap(call => {
		const value = call.fields?.[field];
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? [value] : [];
	}));
}
