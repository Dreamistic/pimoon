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
}

export type AdvisorFailure = "timeout" | "model_unavailable" | "request_failed" | "invalid_card" | "unavailable";
export class ApprovalAdvisorError extends Error {
	constructor(readonly reason: AdvisorFailure) { super(reason); }
}
export function advisorFailureText(reason: AdvisorFailure): string {
	return { timeout: "模型响应超时", model_unavailable: "配置的模型不可用", request_failed: "模型请求失败",
		invalid_card: "模型返回的卡片格式无效", unavailable: "顾问调用失败" }[reason];
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
	return { title, explanation, recommendation, recommendationReason, actions, feedbackPlaceholder,
		...(value.decision === "allow" || value.decision === "ask" || value.decision === "deny" ? { decision: value.decision } : {}) };
}

export async function adviseApproval(
	request: ApprovalRequest,
	decision: Extract<ApprovalDecision, { kind: "ask" }>,
	options: ApprovalOptions,
	config: ApprovalGateConfig,
	ctx: Pick<ExtensionContext, "modelRegistry" | "sessionManager">,
	input: ApprovalAdvisorContext & { signal: AbortSignal },
): Promise<ApprovalCard> {
	const separator = config.model.indexOf("/");
	const model = ctx.modelRegistry.find(config.model.slice(0, separator), config.model.slice(separator + 1));
	if (!model) throw new ApprovalAdvisorError("model_unavailable");
	let style = "";
	try { style = (await readFile(path.join(agentHome, "APPEND_SYSTEM.md"), "utf8")).slice(0, 8000); }
	catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
	input.signal.throwIfAborted();
	const choices = cardChoices(options);
	const payload = approvalAdvisorInput(request, decision, options, style, input);
	const reasoning = clampThinkingLevel(model, "low");
	let measurement: ReturnType<typeof bindAuxiliaryRequest> | undefined;
	let response: AssistantMessage;
	try {
		response = await ctx.modelRegistry.streamSimple(model, {
			systemPrompt: APPROVAL_PROMPT,
			messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
		}, { signal: input.signal, maxTokens: 1800, maxRetries: 0, transport: "sse", ...(reasoning === "off" ? {} : { reasoning }),
			onPayload: (payload, actualModel) => {
				input.signal.throwIfAborted();
				measurement = bindAuxiliaryRequest(payload, actualModel, ctx.sessionManager.getSessionId());
			} }).result();
	} catch (error) { measurement?.finish(); throw error; }
	measurement?.finish(response);
	input.signal.throwIfAborted();
	if (response.stopReason === "error" || response.stopReason === "aborted") throw new ApprovalAdvisorError("request_failed");
	try { return parseApprovalCard(response.content.filter(part => part.type === "text").map(part => part.text).join(""), choices); }
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
