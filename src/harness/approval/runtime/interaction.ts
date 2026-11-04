import { createExactAllowRules, createSimilarAllowRules, describeAllowRules } from "../rules/allow.ts";
import type { ApprovalStore } from "../rules/store.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.ts";

export const ALLOW_ONCE = "Allow once";
export const ALLOW_SESSION = "Allow for session";
export const ALLOW_PERSISTENT = "Always allow similar";
export const DENY = "Deny";
export const DENY_WITH_INSTRUCTION = "Deny with instruction";
export type ApprovalChoice = typeof ALLOW_ONCE | typeof ALLOW_SESSION | typeof ALLOW_PERSISTENT | typeof DENY | typeof DENY_WITH_INSTRUCTION | "Discuss";
export type ApprovalOptions = readonly [ApprovalChoice, ...ApprovalChoice[]];
export type ApprovalScope = "once" | "session" | "persistent";
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
export interface ApprovalReceipt {
	decision: "approved" | "rejected" | "cancelled";
	scope?: ApprovalScope;
	feedback?: string;
	persistence_failed?: boolean;
	actor?: "user" | "advisor";
}
export interface ApprovalDialogOptions {
	timeout?: number;
	signal?: AbortSignal;
	card?: ApprovalCard;
	advisorUnavailable?: boolean;
	advisorFailure?: string;
	discuss?: boolean;
	/** 在保存授权前复核会话、分支、配置及取消状态。 */
	validate?: () => Promise<boolean>;
}
export type ApprovalOutcome = ({ kind: "approved" } | { kind: "blocked"; reason: string }) & { receipt?: ApprovalReceipt };
export interface ApprovalInteractionPort {
	approve(request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>, options: ApprovalOptions, opts?: ApprovalDialogOptions): Promise<ApprovalReply | undefined>;
	input(title: string, placeholder: string, opts?: ApprovalDialogOptions): Promise<string | undefined>;
	notify(message: string, type: "info" | "warning"): void;
}

export function approvalOptions(config: ApprovalGateConfig, decision: Extract<ApprovalDecision, { kind: "ask" }>): ApprovalOptions {
	const units = decision.items.map(item => item.unit);
	return [ALLOW_ONCE,
		...(config.remember.allow_session && units.every(unit => unit.remember.session) ? [ALLOW_SESSION] as const : []),
		...(config.remember.allow_persistent && units.every(unit => unit.remember.persistent) ? [ALLOW_PERSISTENT] as const : []),
		DENY, DENY_WITH_INSTRUCTION];
}

export function approvalScopes(request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>, options: ApprovalOptions): ApprovalScopeOption[] {
	const units = decision.items.map(item => item.unit);
	const scopes: ApprovalScopeOption[] = [{ scope: "once", choice: ALLOW_ONCE, label: "仅本次", detail: "仅批准当前暂停的操作，确认后继续，不重跑整段代码。" }];
	if (options.includes(ALLOW_SESSION)) scopes.push({ scope: "session", choice: ALLOW_SESSION, label: "本会话相同操作", detail: describeAllowRules(createExactAllowRules(request, units)) });
	if (options.includes(ALLOW_PERSISTENT)) scopes.push({ scope: "persistent", choice: ALLOW_PERSISTENT, label: "以后按所示规则", detail: describeAllowRules(createSimilarAllowRules(request, units)) });
	return scopes.filter(option => options.includes(option.choice));
}

function notify(interaction: ApprovalInteractionPort, message: string, type: "info" | "warning"): void {
	try { interaction.notify(message, type); } catch { /* 展示失败不能撤销或伪造已经提交的授权。 */ }
}

export async function handleAskDecision(
	request: ApprovalRequest, decision: Extract<ApprovalDecision, { kind: "ask" }>, config: ApprovalGateConfig,
	store: ApprovalStore, interaction: ApprovalInteractionPort, opts: ApprovalDialogOptions = {},
): Promise<ApprovalOutcome> {
	const cancelled = (): ApprovalOutcome => ({ kind: "blocked", reason: "Approval cancelled or invalidated. No permission was granted.", receipt: { decision: "cancelled" } });
	const valid = async () => !opts.signal?.aborted && (await opts.validate?.() ?? true) && !opts.signal?.aborted;
	if (!await valid()) return cancelled();
	const options = approvalOptions(config, decision);
	const dialog = { ...(config.ui.timeout_ms > 0 ? { timeout: config.ui.timeout_ms } : {}), ...opts };
	const reply = await interaction.approve(request, decision, options, dialog);
	if (!reply || !options.includes(reply.choice) || !await valid()) return cancelled();
	if (reply.actor === "advisor" && reply.choice !== ALLOW_ONCE && reply.choice !== DENY) return cancelled();
	let feedback = reply.feedback?.trim().slice(0, 2000) || undefined;
	if (reply.choice === DENY_WITH_INSTRUCTION && feedback === undefined) {
		feedback = (await interaction.input("Instruction for agent", "Why deny, or what should happen instead?", dialog))?.trim().slice(0, 2000) || undefined;
		if (!await valid()) return cancelled();
	}
	if (reply.choice === DENY || reply.choice === DENY_WITH_INSTRUCTION) return {
		kind: "blocked", reason: `${reply.actor === "advisor" ? "Approval advisor denied" : "User denied"} this tool call. Do not retry without a new user instruction.${feedback ? `\n${reply.actor === "advisor" ? "Advisor reason" : "User feedback"}:\n${feedback}` : ""}`,
		receipt: { decision: "rejected", actor: reply.actor ?? "user", ...(feedback ? { feedback } : {}) },
	};
	let scope: ApprovalScope = reply.choice === ALLOW_SESSION ? "session" : reply.choice === ALLOW_PERSISTENT ? "persistent" : "once";
	const units = decision.items.map(item => item.unit);
	let persistenceFailed = false;
	if (scope === "session") store.addSessionAllowRules(createExactAllowRules(request, units));
	if (scope === "persistent") {
		try {
			await store.addPersistentAllowRules(createSimilarAllowRules(request, units), opts.signal, valid);
			notify(interaction, "审批规则已保存。", "info");
		} catch (error) {
			if (!await valid()) return cancelled();
			scope = "once"; persistenceFailed = true;
			notify(interaction, `审批规则未保存，仅批准本次：${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}
	return { kind: "approved", receipt: { decision: "approved", actor: reply.actor ?? "user", scope, ...(feedback ? { feedback } : {}), ...(persistenceFailed ? { persistence_failed: true } : {}) } };
}
