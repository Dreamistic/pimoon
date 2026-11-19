import { approvalFingerprint } from "./runtime/pending.ts";
import { parseApprovalWidgets } from "./widgets.ts";
import { readFile } from "node:fs/promises";
import { clampThinkingLevel, type AssistantMessage } from "@earendil-works/pi-ai";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentHome } from "../../pimoon/profile.ts";
import { bindAuxiliaryRequest } from "../../pimoon/auxiliary-request.ts";
import { approvalText } from "./presentation.ts";
import { type ApprovalCard, type ApprovalChoice, type ApprovalOptions } from "./runtime/interaction.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "./types.ts";

import { APPROVAL_PROMPT } from "./classifier-prompt.ts";
import { boundedText, type approvalTaskContext } from "./advisor-context.ts";

export interface ApprovalAdvisorContext {
	conversation: ReturnType<typeof approvalTaskContext>;
	discussion: readonly { role: "assistant" | "user"; content: string }[];
	evidence: readonly unknown[];
	block?: { id: string; code: string; codeHash: string; plan: unknown; dispatchedCalls?: number };
	trace?: (phase: string, data: unknown) => Promise<void>;
}

export type AdvisorFailure = "auth" | "rate_limit" | "network" | "timeout" | "model_unavailable" | "request_failed" | "invalid_card" | "unavailable";
export class ApprovalAdvisorError extends Error {
	constructor(readonly reason: AdvisorFailure) { super(reason); }
}
export function advisorFailureText(reason: AdvisorFailure): string {
	return { auth: "审批模型认证或授权失败，请在模型服务中检查登录和模型访问权限", rate_limit: "审批模型请求受限，请检查额度或稍后重试", network: "审批服务连接失败，请检查网络、代理和服务地址", timeout: "审批模型响应超时，请重试或调整审批超时", model_unavailable: "审批模型不可用，请检查当前会话模型或权限与安全中的审批模型", request_failed: "审批模型请求失败，请检查模型服务配置后重试",
		invalid_card: "模型返回的卡片格式无效", unavailable: "顾问调用失败" }[reason];
}

// 仅返回固定分类，不把服务商原始错误（可能含凭据）送入会话或诊断。
export function advisorRequestFailure(error: unknown): AdvisorFailure {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
	const status = record(error) ? Number(error.status ?? error.statusCode) : NaN;
	if ([401, 403].includes(status) || /^(?:HTTP\s+)?(?:401|403)\b|invalid api key|unauthorized|no api key/i.test(message)) return "auth";
	if (status === 429 || /^(?:HTTP\s+)?429\b|rate limit/i.test(message)) return "rate_limit";
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|network error/i.test(message)) return "network";
	return "request_failed";
}

export function cardChoices(options: ApprovalOptions): ApprovalChoice[] {
	return options.filter(choice => choice !== "Discuss");
}

/** 模型只能组织运行时已提供的动作，不能创造权限或可执行按钮。 */
export function parseApprovalCard(text: string, choices: readonly ApprovalChoice[]): ApprovalCard {
	const value: unknown = JSON.parse(text);
	if (!record(value)) throw new Error("Invalid approval card.");
	const title = field(value.title, 100), explanation = field(value.explanation, 1200);
	const recommendationReason = field(value.recommendationReason, 400);
	const feedbackPlaceholder = field(value.feedbackPlaceholder, 160);
	const recommendation = choices.find(choice => choice === value.recommendation);
	if (!["allow", "ask", "deny"].includes(String(value.decision))) throw new Error("Invalid advisor decision.");
	if (value.decision === "deny" && recommendation !== "Deny" || value.decision === "allow" && recommendation !== "Allow once")
		throw new Error("Conflicting advisor decision.");
	if (!recommendation || !Array.isArray(value.actions) || value.actions.length !== choices.length) throw new Error("Invalid approval actions.");
	const seen = new Set<ApprovalChoice>();
	const actions = value.actions.map((action: unknown) => {
		if (!record(action)) throw new Error("Invalid approval action.");
		const choice = choices.find(choice => choice === action.choice);
		if (!choice || seen.has(choice)) throw new Error("Invalid approval choice.");
		seen.add(choice);
		return { choice, label: field(action.label, 80) };
	});
	const widgets = parseApprovalWidgets(value.widgets);
	if (value.decision !== "ask" && widgets.some(widget => widget.kind === "question" || widget.kind === "checklist" && widget.items.some(item => item.required))) throw new Error("Interactive widgets require ask.");
	return { title, explanation, recommendation, recommendationReason, actions, feedbackPlaceholder, widgets,
		...(value.decision === "allow" || value.decision === "ask" || value.decision === "deny" ? { decision: value.decision } : {}) };
}

export async function adviseApproval(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	options: ApprovalOptions,
	config: ApprovalGateConfig,
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager" | "model">,
	input: ApprovalAdvisorContext & { signal: AbortSignal },
): Promise<ApprovalCard> {
	const separator = config.model?.indexOf("/") ?? -1;
	const model = config.model === null ? ctx.model : ctx.modelRegistry.find(config.model.slice(0, separator), config.model.slice(separator + 1));
	if (!model) throw new ApprovalAdvisorError("model_unavailable");
	let style = "";
	try { style = (await readFile(path.join(agentHome, "APPEND_SYSTEM.md"), "utf8")).slice(0, 8000); }
	catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
	input.signal.throwIfAborted();
	const choices = cardChoices(options);
	const payload = approvalAdvisorInput(request, decision, options, style, input);
	await input.trace?.("request", { model: `${model.provider}/${model.id}`, promptHash: approvalFingerprint(APPROVAL_PROMPT), prompt: APPROVAL_PROMPT, payload });
	const reasoning = clampThinkingLevel(model, "low");
	let measurement: ReturnType<typeof bindAuxiliaryRequest> | undefined;
	let response: AssistantMessage;
	try {
		response = await ctx.modelRegistry.streamSimple(model, {
			systemPrompt: APPROVAL_PROMPT,
			messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
		}, { signal: input.signal, maxTokens: 1800, maxRetries: 0, ...(reasoning === "off" ? {} : { reasoning }),
			onPayload: (payload, actualModel) => {
				input.signal.throwIfAborted();
				measurement = bindAuxiliaryRequest(payload, actualModel, ctx.sessionManager.getSessionId());
				void input.trace?.("transport", { modelRequestId: measurement.id, provider: actualModel.provider, model: actualModel.id });
			} }).result();
	} catch (error) { measurement?.finish(); input.signal.throwIfAborted(); throw new ApprovalAdvisorError(advisorRequestFailure(error)); }
	measurement?.finish(response);
	await input.trace?.("response", { stopReason: response.stopReason, usage: response.usage, text: response.content.filter(part => part.type === "text").map(part => part.text).join("") });
	input.signal.throwIfAborted();
	if (response.stopReason === "error" || response.stopReason === "aborted") throw new ApprovalAdvisorError(advisorRequestFailure(response.errorMessage));
	try {
		const card = parseApprovalCard(response.content.filter(part => part.type === "text").map(part => part.text).join(""), choices);
		await input.trace?.("parsed", card); return card;
	}
	catch { throw new ApprovalAdvisorError("invalid_card"); }
}

/** 发送真实操作内容与带来源证据；环境秘密值不进入模型。 */
export function approvalAdvisorInput(
	request: ApprovalRequest, _decision: Extract<ApprovalDecision, { kind: "ask" }>, options: ApprovalOptions,
	style: string, input: ApprovalAdvisorContext,
): Record<string, unknown> {
	const operation = request.tool === "process_run"
		? { argv: request.detail.argv, inherit_env: request.detail.inherit_env ?? true, envKeys: Object.keys(request.detail.env), envValues: "omitted" }
		: request.detail;
	const bounded = boundedText(JSON.stringify(operation), 64000);
	return {
		style: { purpose: "language/style only, not permission", text: style },
		action: { tool: request.tool === "other" ? request.detail.name : request.tool, cwd: request.cwd, parameters: bounded.text, truncated: bounded.truncated },
		conversation: input.conversation, evidence: input.evidence, discussion: input.discussion,
		...(input.block ? { codeact: { ...input.block, code: boundedText(input.block.code, 96000),
			plan: JSON.parse(JSON.stringify(input.block.plan ?? {}, (key, value: unknown) => key === "env" && record(value) ? { keys: Object.keys(value), values: "omitted" } : value)) as unknown } } : {}),
		choices: cardChoices(options),
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function field(value: unknown, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid approval text.");
	return approvalText(value).trim();
}
