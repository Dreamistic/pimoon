import { record } from "../../pimoon/telemetry.ts";
import { sessionTrace } from "../../pimoon/trace.ts";

export type ApprovalDiagnostic =
	| { phase: "routine"; category: string; elapsedMs: number }
	| { phase: "advisor_start"; model: string; contextCount: number; evidenceCount: number; discussionCount: number }
	| { phase: "advisor_end"; decision: string; recommendation: string; elapsedMs: number }
	| { phase: "advisor_failure"; reason: string; elapsedMs: number }
	| { phase: "present" }
	| { phase: "resolved"; outcome: string; actor: string; scope: string; elapsedMs: number }
	| { phase: "invalidated"; reason: "context_changed" | "exception" };

/** 严格选取诊断元数据；不记录命令、路径、提示词、回复正文或错误原文。 */
export function approvalDiagnostic(session: string, callId: string, requestHash: string, tool: string, event: ApprovalDiagnostic): void {
	record("approval_diagnostic", { ...sessionTrace(session), tool_call_id: callId, request_hash: requestHash, tool, ...event });
}
