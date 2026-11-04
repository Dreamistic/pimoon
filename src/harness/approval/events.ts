export const APPROVAL_STATUS_CHANNEL = "approval-gate:status";

export type ApprovalStatusEvent =
	| { type: "requested"; toolCallId: string; toolName: string }
	| { type: "resolved"; toolCallId: string; outcome: "approved" | "denied" };

export function isApprovalStatusEvent(value: unknown): value is ApprovalStatusEvent {
	if (typeof value !== "object" || value === null || !("toolCallId" in value) || typeof value.toolCallId !== "string" || !("type" in value)) return false;
	return value.type === "requested" ? "toolName" in value && typeof value.toolName === "string"
		: value.type === "resolved" && "outcome" in value && (value.outcome === "approved" || value.outcome === "denied");
}
