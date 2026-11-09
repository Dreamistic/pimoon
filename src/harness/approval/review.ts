import { approvalFingerprint } from "./runtime/pending.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalGateConfig, ApprovalRequest } from "./types.ts";
import { adviseApproval, ApprovalAdvisorError, advisorFailureText } from "./advisor.ts";
import { approvalTaskContext } from "./advisor-context.ts";
import { collectBlockEvidence } from "./evidence.ts";
import { approvalDiagnostic } from "./diagnostics.ts";
import { appendApprovalTrace } from "./trace-store.ts";
import { APPROVAL_OPTIONS, type ApprovalCard, type ApprovalReply } from "./runtime/interaction.ts";
import type { ApprovalPresenter } from "./pi/proposal.ts";
import { canPresent } from "../presentation.ts";
import { formatApprovalPrompt } from "./presentation.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "./events.ts";
import type { BlockPlan } from "./block-plan.ts";
import type { ApprovalBlock } from "./block.ts";

export interface ReviewResult { allowed: boolean; reason: string; actor: "advisor" | "user" | "host"; outcome: string; reviewId: string }
export async function reviewOperation(args: {
	pi: ExtensionAPI; ctx: ExtensionContext; request: ApprovalRequest; config: ApprovalGateConfig;
	callId: string; hash: string; reviewId: string; signal: AbortSignal; valid: () => Promise<boolean>;
	evidence: readonly unknown[]; presenter?: ApprovalPresenter; block?: ApprovalBlock; plan?: BlockPlan;
}): Promise<ReviewResult> {
	const { pi, ctx, request, config, callId, hash, reviewId, signal, valid } = args;
	const diagnostic = (value: Parameters<typeof approvalDiagnostic>[4]) => approvalDiagnostic(ctx.sessionManager.getSessionId(), callId, hash, request.tool, value);
	const trace = (phase: string, data: unknown): Promise<void> => {
		void appendApprovalTrace(reviewId, phase, data, config.diagnostics ?? { enabled: false, retention_days: 7, max_mb: 32 })
			.catch(() => diagnostic({ phase: "trace_failure" }));
		return Promise.resolve();
	};
	const result = (allowed: boolean, reason: string, actor: ReviewResult["actor"], outcome: string): ReviewResult => ({ allowed, reason, actor, outcome, reviewId });
	const asked = { kind: "ask" as const, reason: args.block ? "CodeAct batch review" : "AI security review", items: request.units.map(unit => ({ unit, reason: "Pending decision" })) };
	const discussion: { role: "assistant" | "user"; content: string }[] = [];
	const started = performance.now(); let requested = false, approved = false;
	await trace("begin", { sessionId: ctx.sessionManager.getSessionId(), callId, blockId: args.block?.id, requestHash: hash, configHash: approvalFingerprint(config), model: config.model });
	try {
		for (;;) {
			const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), config.timeout_ms);
			const advisorSignal = AbortSignal.any([signal, timeout.signal]);
			let card: ApprovalCard;
			try {
				const evidence = await abortable(collectBlockEvidence(request, args.plan, ctx.cwd, advisorSignal), advisorSignal);
				const conversation = approvalTaskContext(ctx);
				diagnostic({ phase: "advisor_start", model: config.model, contextCount: conversation.entries.length, evidenceCount: evidence.length + args.evidence.length, discussionCount: discussion.length });
				card = await abortable(adviseApproval(request, asked, APPROVAL_OPTIONS, config, ctx, {
					conversation, evidence: [...evidence, ...args.evidence], discussion, signal: advisorSignal, trace,
					...(args.block ? { block: { id: args.block.id, code: args.block.code, codeHash: args.block.codeHash, plan: args.plan, dispatchedCalls: [...args.block.seen.values()].reduce((sum, count) => sum + count, 0) } } : {}),
				}), advisorSignal);
				diagnostic({ phase: "advisor_end", decision: card.decision ?? "missing", recommendation: card.recommendation, elapsedMs: performance.now() - started });
			} catch (error) {
				const reason = timeout.signal.aborted ? "timeout" : error instanceof ApprovalAdvisorError ? error.reason : "unavailable";
				diagnostic({ phase: "advisor_failure", reason, elapsedMs: performance.now() - started });
				await trace("failure", { reason, cancelled: signal.aborted });
				return result(false, `Approval unavailable: ${advisorFailureText(reason)}. Not executed; not a policy denial.`, "host", "unavailable");
			} finally { clearTimeout(timer); timeout.abort(); }
			if (!await valid()) return result(false, "Approval context changed. Not executed.", "host", "cancelled");
			let reply: ApprovalReply | undefined;
			if (card.decision === "deny") reply = { choice: "Deny", actor: "advisor", feedback: card.explanation };
			else if (card.decision === "allow" && discussion.length === 0) reply = { choice: "Allow once", actor: "advisor", feedback: card.explanation };
			else {
				if (card.decision !== "ask" && card.decision !== "allow") throw new Error("Missing classifier decision");
				if (!requested) { requested = true; pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId: callId, toolName: "approval" } satisfies ApprovalStatusEvent); }
				const opts = { signal, card, discuss: true, reviewId,
					...(args.block ? { block: { id: args.block.id, code: args.block.code, codeHash: args.block.codeHash, plannedCalls: args.plan?.calls.length ?? 0, dispatchedCalls: [...args.block.seen.values()].reduce((sum, count) => sum + count, 0), unresolvedLines: args.plan?.unresolvedLines ?? [0] } } : {}) };
				diagnostic({ phase: "present" }); await trace("present", { card, block: opts.block });
				if (args.presenter && canPresent(ctx, args.presenter)) reply = await abortable(args.presenter.show(ctx.ui, request, asked, APPROVAL_OPTIONS, opts), signal);
				else if (ctx.hasUI) {
					const choice = await abortable(ctx.ui.select(`${card.title}\n${card.explanation}\n${args.block ? args.block.code : formatApprovalPrompt(request, asked)}`, [...APPROVAL_OPTIONS], opts), signal);
					reply = choice === "Allow once" || choice === "Deny" ? { choice } : undefined;
				} else return result(false, "AI requested a human decision, but no interactive UI is available. Not executed.", "host", "unavailable");
				if (!await valid()) return result(false, "Approval cancelled or context changed. Not executed.", "host", "cancelled");
				await trace("interaction", reply ?? { choice: "cancelled" });
				if (reply?.choice === "Discuss") {
					const answer = JSON.stringify({ feedback: reply.feedback ?? "", answers: reply.answers ?? {} });
					discussion.push({ role: "assistant", content: card.explanation }, { role: "user", content: answer.slice(0, 4000) });
					if (discussion.length > 20) return result(false, "Clarification limit reached; start a new CodeAct.", "host", "cancelled");
					continue;
				}
			}
			approved = reply?.choice === "Allow once";
			const actor = reply?.actor ?? "user", outcome = approved ? "approved" : reply ? "rejected" : "cancelled";
			const reason = approved ? reply?.feedback ?? card.explanation : `${actor === "advisor" ? "AI denied" : "User rejected or cancelled"} this ${args.block ? "CodeAct block" : "action"}.${reply?.feedback ? `\n${reply.feedback}` : ""} Do not retry unchanged without new evidence or user direction.`;
			await trace("resolved", { allowed: approved, actor, outcome, reason, answers: reply?.answers });
			diagnostic({ phase: "resolved", outcome, actor, scope: args.block ? "codeact" : "once", elapsedMs: performance.now() - started });
			return result(approved, reason, actor, outcome);
		}
	} finally {
		if (requested) pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId: callId, outcome: approved ? "approved" : "denied" } satisfies ApprovalStatusEvent);
	}
}

export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Approval cancelled"));
		if (signal.aborted) { pending.catch(() => {}); abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
