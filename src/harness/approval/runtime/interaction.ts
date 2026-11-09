import type { ApprovalDecision, ApprovalRequest } from "../types.ts";

export const ALLOW_ONCE = "Allow once";
export const DENY = "Deny";
export type ApprovalChoice = typeof ALLOW_ONCE | typeof DENY | "Discuss";
export type ApprovalOptions = readonly [ApprovalChoice, ...ApprovalChoice[]];
export type ApprovalScope = "once";
export interface ApprovalCard {
	title: string;
	explanation: string;
	decision?: "allow" | "ask" | "deny";
	recommendation: ApprovalChoice;
	recommendationReason: string;
	actions: { choice: ApprovalChoice; label: string }[];
	feedbackPlaceholder: string;
}
export interface ApprovalReply { choice: ApprovalChoice; feedback?: string; actor?: "advisor" }
export interface ApprovalScopeOption { scope: ApprovalScope; choice: ApprovalChoice; label: string; detail: string }
export interface ApprovalDialogOptions {
	timeout?: number;
	signal?: AbortSignal;
	card?: ApprovalCard;
	discuss?: boolean;
}
export interface ApprovalInteractionPort {
	approve(request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>, options: ApprovalOptions, opts?: ApprovalDialogOptions): Promise<ApprovalReply | undefined>;
	input(title: string, placeholder: string, opts?: ApprovalDialogOptions): Promise<string | undefined>;
	notify(message: string, type: "info" | "warning"): void;
}

export const APPROVAL_OPTIONS: ApprovalOptions = [ALLOW_ONCE, DENY];

export function approvalScopes(_request: ApprovalRequest, _decision: Extract<ApprovalDecision, { kind: "ask" }>, options: ApprovalOptions): ApprovalScopeOption[] {
	return options.includes(ALLOW_ONCE) ? [{ scope: "once", choice: ALLOW_ONCE, label: "仅本次",
		detail: "仅批准当前暂停的操作；继续原调用，不重跑整段代码，不生成长期权限。" }] : [];
}
