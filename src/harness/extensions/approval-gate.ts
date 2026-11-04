import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadApprovalGateConfig } from "../approval/config.ts";
import { createApprovalGate, blockForDenyRule } from "../approval/runtime/gate.ts";
import { approvalFingerprint } from "../approval/runtime/pending.ts";
import { approvalBinding, type ApprovalPresenter } from "../approval/pi/proposal.ts";
import { adviseApproval, ApprovalAdvisorError, advisorFailureText } from "../approval/advisor.ts";
import { approvalPresence } from "../approval/presence.ts";
import { approvalTaskContext } from "../approval/advisor-context.ts";
import { ApprovalExperiences, type ApprovalExperience } from "../approval/experience.ts";
import { buildApprovalRequest, isApprovalToolCall } from "../approval/pi/request.ts";
import { buildBashApprovalRequest } from "../approval/request/bash/parse.ts";
import { formatBashPolicyEvaluation } from "../approval/rules/bash-facts.ts";
import { evaluateBashGatePolicy } from "../approval/rules/policy.ts";
import { approvalSummary, formatApprovalPrompt } from "../approval/presentation.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../approval/events.ts";
import { canPresent } from "../presentation.ts";
import { attachPrivateNetworkGrant, createPrivateNetworkGrantFor } from "../web-tools/network/private-network-grant.ts";

export type { ApprovalPresenter } from "../approval/pi/proposal.ts";
export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter, gate = createApprovalGate()): void {
	let lifetime = new AbortController(), queue: Promise<void> = Promise.resolve(), task = "";
	const closed = new Set<string>(), history: ApprovalExperience[] = [];
	const feedback = new Map<string, { text: string; advisor: boolean }>();
	const evidence: string[] = [];
	let closedPolicy = "";
	const reset = () => { lifetime.abort(); lifetime = new AbortController(); closed.clear(); feedback.clear(); };
	pi.on("before_agent_start", event => { reset(); if (event.messageType === "user") task = event.prompt; });
	pi.on("session_start", () => { reset(); history.length = 0; evidence.length = 0; task = ""; });
	pi.on("session_tree", reset);
	pi.on("session_shutdown", reset);
	pi.registerCommand("approval-check", {
		description: "Explain the Bash gate decision without executing the command.",
		async handler(args, ctx) {
			const command = args.trim();
			if (!command) { ctx.ui.notify("Usage: /approval-check <bash command>", "warning"); return; }
			const [config, request] = await Promise.all([loadApprovalGateConfig(), buildBashApprovalRequest(command, ctx.cwd)]);
			const evaluation = evaluateBashGatePolicy(request, config, { matchesAllowRule: () => false });
			ctx.ui.notify(formatBashPolicyEvaluation(evaluation.bash, config.enabled ? evaluation.decision : { kind: "allow" }),
				evaluation.decision.kind === "deny" ? "warning" : "info");
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!isApprovalToolCall(event)) return;
		const config = await loadApprovalGateConfig();
		if (!config.enabled) return;
		const request = await buildApprovalRequest(event, ctx.cwd);
		if (!request) return;
		const experiences = new ApprovalExperiences(config.remember.persistent_store);
		const currentPolicy = approvalFingerprint(config);
		if (closedPolicy !== currentPolicy) { closed.clear(); closedPolicy = currentPolicy; }
		const key = approvalFingerprint(request);
		if (closed.has(key)) return { block: true, reason: "Approval closed. Wait for a new user instruction; do not retry or bypass." };
		const decision = await gate.inspect(request, config);
		if (decision.kind === "deny") return { block: true, reason: blockForDenyRule(decision).reason };
		if (decision.kind === "ask") {
			// 并发调用逐个展示；前一个保存规则后，下一个在 authorize 内重新检查。
			const previous = queue;
			let release = () => {};
			queue = new Promise<void>(resolve => { release = resolve; });
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
			const binding = approvalBinding(ctx), inputHash = approvalFingerprint(event.input), policy = approvalFingerprint(config);
			const valid = async () => !signal.aborted && approvalBinding(ctx) === binding
				&& approvalFingerprint(event.input) === inputHash && approvalFingerprint(await loadApprovalGateConfig()) === policy;
			let requested = false, approved = false;
			try {
				await previous;
				if (closed.has(key)) return { block: true, reason: "Approval closed. Wait for a new user instruction; do not retry or bypass." };
				if (!await valid()) return { block: true, reason: "Approval cancelled or context changed. No permission granted." };
				const outcome = await gate.authorize(request, config, ctx.hasUI || config.advisor?.autonomous ? {
					async approve(current, asked, options, opts) {
						const discussion: string[] = [];
						requested = true;
						pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId: event.toolCallId, toolName: "approval" } satisfies ApprovalStatusEvent);
						for (;;) {
							const presence = approvalPresence();
							let card, advisorUnavailable = false, advisorFailure: string | undefined;
							if (config.advisor?.enabled) {
								const timeout = new AbortController(), advisorSignal = AbortSignal.any([signal, timeout.signal]);
								const timer = setTimeout(() => timeout.abort(), config.advisor.timeout_ms);
								try {
									const stored = await experiences.relevant(current).catch(() => []);
									const previous = stored.filter(entry => !history.some(item => item.requestHash === entry.requestHash));
									const pending = adviseApproval(current, asked, options, config.advisor, ctx,
										{ task, requestHash: key, history: [...previous, ...history].slice(-12), signal: advisorSignal, discussion, presence, context: approvalTaskContext(ctx), evidence: [...evidence] });
									card = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
										if (advisorSignal.aborted) reject(new Error("Advisor cancelled."));
										else advisorSignal.addEventListener("abort", () => reject(new Error("Advisor cancelled.")), { once: true });
									})]);
								} catch (error) {
									advisorUnavailable = true;
									advisorFailure = advisorFailureText(timeout.signal.aborted ? "timeout"
										: error instanceof ApprovalAdvisorError ? error.reason : "unavailable");
								}
								finally { clearTimeout(timer); timeout.abort(); }
							}
							if (!await valid()) return;
							if (config.advisor?.autonomous) {
								if (!card || !card.decision || approvalPresence().state === "away" && card.decision === "ask")
									return { choice: "Deny", actor: "advisor", feedback: advisorFailure ?? "AI无法形成有效放行判断，本次不执行。" };
								if (card.decision !== "ask") return {
									choice: card.decision === "allow" ? "Allow once" : "Deny", actor: "advisor", feedback: card.explanation,
								};
							}
							const dialog = { ...opts, ...(card ? { card } : {}), advisorUnavailable, ...(advisorFailure ? { advisorFailure } : {}), discuss: Boolean(card) };
							if (present && canPresent(ctx, present)) {
								const waiting = new AbortController();
								const timer = config.advisor?.autonomous ? setInterval(() => {
									if (approvalPresence().state === "away") waiting.abort();
								}, 1000) : undefined;
								let reply;
								try {
									reply = await present.show(ctx.ui, current, asked, options, { ...dialog,
										signal: AbortSignal.any([signal, waiting.signal]) });
								} finally { clearInterval(timer); }
								if (waiting.signal.aborted && !signal.aborted) continue;
								if (reply?.choice !== "Discuss") return reply;
								if (!reply.feedback?.trim() || !await valid()) return;
								discussion.push(`AI: ${card?.explanation ?? ""}`, `User: ${reply.feedback.slice(0, 2000)}`);
								if (discussion.length > 6) discussion.splice(0, discussion.length - 6);
								continue;
							}
							const choice = await ctx.ui.select([card?.title, card?.explanation, formatApprovalPrompt(current, asked)].filter(Boolean).join("\n\n"), [...options], dialog);
							const offered = options.find(option => option === choice);
							return offered ? { choice: offered } : undefined;
						}
					},
					input: (title, placeholder, opts) => ctx.ui.input(title, placeholder, opts),
					notify: (message, type) => ctx.ui.notify(message, type),
				} : undefined, { signal, validate: valid });
				approved = outcome.kind === "approved";
				const receipt = outcome.receipt;
				if (receipt) {
					const experience: ApprovalExperience = { requestHash: key, tool: request.tool, decision: receipt.decision, actor: receipt.actor ?? "user", summary: approvalSummary(request),
						...(receipt.scope ? { scope: receipt.scope } : {}), ...(receipt.feedback ? { feedback: receipt.feedback } : {}) };
					history.push(experience); if (history.length > 24) history.shift();
					if (config.advisor?.enabled && receipt.actor !== "advisor") {
						try { await experiences.remember(request, receipt); }
						catch { ctx.ui.notify("审批已处理，但经验未保存；授权结果不变。", "warning"); }
					}
					const { feedback: note, ...audit } = receipt;
					try { pi.appendEntry("approval_decision", { request_hash: key, tool: request.tool, ...audit, has_feedback: Boolean(note) }); }
					catch { ctx.ui.notify("审批已处理，但审计记录未保存。", "warning"); }
					if (note && outcome.kind === "approved") feedback.set(event.toolCallId, { text: note, advisor: receipt.actor === "advisor" });
				}
				if (outcome.kind === "blocked") { closed.add(key); return { block: true, reason: outcome.reason }; }
			} catch {
				closed.add(key);
				return { block: true, reason: "Approval unavailable. No permission granted; wait for a new user instruction." };
			} finally {
				if (requested) pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId: event.toolCallId, outcome: approved ? "approved" : "denied" } satisfies ApprovalStatusEvent);
				release();
			}
		}
		if (request.tool === "webfetch" || request.tool === "http") attachPrivateNetworkGrant(event.input, createPrivateNetworkGrantFor(request.detail.origin, request.detail.addresses));
	});
	// 反馈随原调用结果进入主模型，不额外触发一轮提案，也不自动变成授权。
	pi.on("tool_result", event => {
		if (event.toolName === "process_run") {
			const detail: unknown = event.details;
			const result = typeof detail === "object" && detail !== null && "exit_code" in detail ? `exit_code=${String(detail.exit_code)}` : event.isError ? "error" : "completed";
			const argv = "argv" in event.input ? JSON.stringify(event.input.argv).slice(0, 400) : "";
			const output = event.content.filter(part => part.type === "text").map(part => part.text).join("\n").slice(-1400);
			evidence.push(`process_run ${argv}: ${result}\n${output}`);
			if (evidence.length > 8) evidence.shift();
		}
		const note = feedback.get(event.toolCallId);
		feedback.delete(event.toolCallId);
		if (note) return { content: [...event.content, { type: "text" as const, text: `${note.advisor ? "Advisor decision reason" : "Approval feedback"} (not new authorization):\n${note.text}` }] };
	});
}
