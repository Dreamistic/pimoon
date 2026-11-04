import path from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { canPresent, type Presenter } from "../../presentation.ts";
import { loadApprovalGateConfig } from "../config.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../events.ts";
import { formatApprovalPrompt } from "../presentation.ts";
import type { createApprovalGate } from "../runtime/gate.ts";
import { approvalOptions, approvalScopes, type ApprovalInteractionPort, type ApprovalOutcome } from "../runtime/interaction.ts";
import { approvalFingerprint, type PendingApprovals, type ApprovalBinding } from "../runtime/pending.ts";

export type ApprovalPresenter = Presenter<(ui: ExtensionUIContext, ...args: Parameters<ApprovalInteractionPort["approve"]>) => ReturnType<ApprovalInteractionPort["approve"]>>;

export function approvalBinding(ctx: ExtensionContext): ApprovalBinding {
	return { session: ctx.sessionManager.getSessionId(), cwd: path.resolve(ctx.cwd),
		leaf: ctx.sessionManager.getBranch().findLast(entry => !["session_info", "label", "usage"].includes(entry.type) && !(entry.type === "custom" && entry.customType === "approval_decision"))?.id ?? null };
}

export function registerApprovalProposal(pi: ExtensionAPI, gate: ReturnType<typeof createApprovalGate>, pending: PendingApprovals, present?: ApprovalPresenter): void {
	pi.registerTool({
		name: "approval", label: "审批", defaultActive: true,
		description: "Present a blocked request; explain purpose/risk and suggest an offered scope. Returns the user's decision without executing it.",
		parameters: Type.Object({ request_id: Type.String({ minLength: 1, maxLength: 64 }), reason: Type.String({ minLength: 1, maxLength: 800, pattern: "\\S" }),
			scope: Type.Union([Type.Literal("once"), Type.Literal("session"), Type.Literal("persistent")]) }, { additionalProperties: false }),
		outputSchema: Type.Object({ status: Type.String(), scope: Type.Optional(Type.String()), feedback: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }, { additionalProperties: true }),
		async execute(toolCallId, input, signal, _update, ctx) {
			const result = (data: JsonObject) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, details: data });
			const item = pending.claim(input.request_id);
			if (!item) return result({ status: "unavailable", reason: "Unknown, expired or already presented request. No permission granted." });
			const binding = approvalBinding(ctx);
			const config = await loadApprovalGateConfig();
			const valid = async () => {
				const policy = approvalFingerprint(await loadApprovalGateConfig());
				const current = approvalBinding(ctx);
				return !signal?.aborted && pending.active(item) && current.session === item.binding.session && current.cwd === item.binding.cwd
					&& current.leaf === binding.leaf && (item.binding.leaf === null || ctx.sessionManager.getBranch().some(entry => entry.id === item.binding.leaf))
					&& policy === item.policy;
			};
			if (!ctx.hasUI || !await valid()) { pending.finish(item, "closed"); return result({ status: "cancelled", reason: "Approval context changed or UI unavailable. No permission granted." }); }
			const decision = await gate.inspect(item.request, config);
			if (decision.kind !== "ask") {
				pending.finish(item, decision.kind === "allow" ? "granted" : "closed");
				return result({ status: decision.kind === "allow" ? "already_allowed" : "denied", ...(decision.kind === "deny" ? { reason: decision.reason } : {}) });
			}
			const scopes = approvalScopes(item.request, decision, approvalOptions(config, decision));
			if (!scopes.some(option => option.scope === input.scope)) {
				item.state = "pending";
				return result({ status: "invalid_scope", available: scopes.map(option => ({ ...option })), reason: "Choose an offered scope; no permission granted." });
			}
			let outcome: ApprovalOutcome | undefined;
			try {
				pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId, toolName: "approval" } satisfies ApprovalStatusEvent);
				outcome = await gate.authorize(item.request, config, {
					async approve(request, asked, options, opts) {
						if (present && canPresent(ctx, present)) return present.show(ctx.ui, request, asked, options, opts);
						const choice = await ctx.ui.select(`${input.reason}\n\n${formatApprovalPrompt(request, asked)}`, [...options], opts);
						const offered = options.find(option => option === choice);
						return offered ? { choice: offered } : undefined;
					},
					input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts),
					notify: (message, type) => ctx.ui.notify(message, type),
				}, { ...(signal ? { signal } : {}), timeout: Math.max(1, Math.min(item.expires - Date.now(), config.ui.timeout_ms || Infinity)),
					proposal: { reason: input.reason, scope: input.scope }, validate: valid });
				pending.finish(item, outcome.kind === "approved" ? outcome.receipt?.scope === "once" ? "once" : "granted" : "closed");
				let auditPending = false;
				if (outcome.receipt) {
					const { feedback, ...receipt } = outcome.receipt;
					try { pi.appendEntry("approval_decision", { request_id: item.id, request_hash: item.key, tool: item.request.tool, ...receipt, has_feedback: Boolean(feedback) }); }
					catch { auditPending = true; }
				}
				return result({ ...(auditPending ? { audit_pending: true } : {}), status: outcome.kind, request_id: item.id, tool: item.request.tool, ...outcome.receipt,
					...(outcome.kind === "blocked" ? { reason: outcome.reason } : { next: "Retry only the blocked call with identical arguments. Earlier effects remain completed." }) });
			} catch {
				pending.finish(item, "closed");
				return result({ status: "cancelled", reason: "Approval unavailable. Do not retry without a new user instruction." });
			} finally {
				pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId, outcome: outcome?.kind === "approved" ? "approved" : "denied" } satisfies ApprovalStatusEvent);
			}
		},
	});
}
