import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { GuiMessage } from "../../shared/messages/types.ts";

/** 审批审计只投影到界面，不向模型上下文追加消息。 */
export function approvalDecisionMessages(entry: SessionEntry): GuiMessage[] | undefined {
	if (entry.type !== "custom" || entry.customType !== "approval_decision") return undefined;
	const data: unknown = entry.data;
	if (!data || typeof data !== "object" || !("actor" in data) || !("decision" in data)) return undefined;
	const actor = data.actor === "delegate" ? "委派代理" : data.actor === "user" ? "用户"
		: data.actor === "advisor" ? "审批顾问" : data.actor === "host" ? "宿主" : undefined;
	const decision = data.decision === "approved" ? "已批准" : data.decision === "rejected" ? "已拒绝"
		: data.decision === "cancelled" ? "已取消" : data.decision === "unavailable" ? "审批不可用" : undefined;
	if (!actor || !decision) return undefined;
	return [{ role: "custom", customType: "approval_decision", display: true,
		content: `审批: ${actor} / ${decision}`, timestamp: Date.parse(entry.timestamp) }];
}
