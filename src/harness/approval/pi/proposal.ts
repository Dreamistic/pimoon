import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Presenter } from "../../presentation.ts";
import type { ApprovalInteractionPort } from "../runtime/interaction.ts";

/** 各前端共用运行时审批端口，不向主模型暴露二次提案工具。 */
export type ApprovalPresenter = Presenter<(ui: ExtensionUIContext, ...args: Parameters<ApprovalInteractionPort["approve"]>) => ReturnType<ApprovalInteractionPort["approve"]>>;

export function approvalBinding(ctx: ExtensionContext): string {
	return JSON.stringify({
		session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
		leaf: ctx.sessionManager.getBranch().findLast(entry => !["session_info", "label", "usage"].includes(entry.type)
			&& !(entry.type === "custom" && entry.customType === "approval_decision"))?.id ?? null,
	});
}
