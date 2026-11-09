import { grantRoutineInspection } from "../approval/routine-file-grant.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { routineOperation } from "../approval/routine.ts";
import { grantRoutineProcess } from "../approval/routine-process-grant.ts";
import { loadApprovalGateConfig } from "../approval/config.ts";
import { approvalFingerprint } from "../approval/runtime/pending.ts";
import { approvalBinding, type ApprovalPresenter } from "../approval/pi/proposal.ts";
import { adviseApproval, ApprovalAdvisorError, advisorFailureText } from "../approval/advisor.ts";
import { approvalDiagnostic } from "../approval/diagnostics.ts";
import { approvalTaskContext, boundedText } from "../approval/advisor-context.ts";
import { collectApprovalEvidence } from "../approval/evidence.ts";
import { buildApprovalRequest, isApprovalToolCall } from "../approval/pi/request.ts";
import { APPROVAL_OPTIONS, type ApprovalCard, type ApprovalReply } from "../approval/runtime/interaction.ts";
import { formatApprovalPrompt } from "../approval/presentation.ts";
import { APPROVAL_STATUS_CHANNEL, type ApprovalStatusEvent } from "../approval/events.ts";
import { canPresent } from "../presentation.ts";
import { attachPrivateNetworkGrant, createPrivateNetworkGrantFor } from "../web-tools/network/private-network-grant.ts";

export type { ApprovalPresenter } from "../approval/pi/proposal.ts";

/** 常规本地开发直接执行；其余由独立 AI 裁决，宿主保证上下文绑定和取消。 */
export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter): void {
	let lifetime = new AbortController(), queue: Promise<void> = Promise.resolve();
	const feedback = new Map<string, { text: string; actor: string }>();
	const recent: unknown[] = [];
	const created = new Set<string>(), pendingFiles = new Map<string, string>();
	const reset = () => { lifetime.abort(); lifetime = new AbortController(); feedback.clear(); created.clear(); pendingFiles.clear(); };
	pi.on("before_agent_start", reset);
	pi.on("session_start", () => { reset(); recent.length = 0; });
	pi.on("session_tree", () => { reset(); recent.length = 0; });
	pi.on("session_shutdown", reset);
	pi.on("tool_call", async (event, ctx) => {
		if (!isApprovalToolCall(event)) return;
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
		const binding = approvalBinding(ctx), inputHash = approvalFingerprint(event.input);
		let config, request;
		try {
			config = await loadApprovalGateConfig();
			if (!config.enabled) return;
			request = await buildApprovalRequest(event, ctx.cwd);
		} catch {
			return { block: true, reason: "Approval configuration or request inspection failed. Nothing executed." };
		}
		if (!request) return { block: true, reason: "Approval could not inspect this request. Nothing executed." };
		const key = approvalFingerprint(request), policyHash = approvalFingerprint(config);
		const valid = async () => !signal.aborted && approvalBinding(ctx) === binding
			&& approvalFingerprint(event.input) === inputHash && approvalFingerprint(await loadApprovalGateConfig()) === policyHash;
		const diagnostic = (value: Parameters<typeof approvalDiagnostic>[4]) =>
			approvalDiagnostic(ctx.sessionManager.getSessionId(), event.toolCallId, key, request.tool, value);
		const routingStarted = performance.now();
		try {
			const category = config.routine !== false ? await routineOperation(request, ctx.cwd, created) : undefined;
			if (category && request.tool === "process_run") await grantRoutineProcess(event.input, ctx.cwd, category);
			if (category === "local_inspection") await grantRoutineInspection(event.input, ctx.cwd);
			if (!await valid()) return { block: true, reason: "Approval context changed. Nothing executed." };
			if (category) {
				if (category === "project_new_file" && request.tool === "write") pendingFiles.set(event.toolCallId, request.detail.path);
				diagnostic({ phase: "routine", category, elapsedMs: performance.now() - routingStarted });
				return;
			}
		} catch {
			// 无法识别的路径或 CLI 不直接拒绝，继续原有 AI 判断。
			if (signal.aborted) return { block: true, reason: "Approval cancelled. Nothing executed." };
		}
		const previous = queue;
		let release = () => {};
		const turn = new Promise<void>(resolve => { release = resolve; });
		queue = previous.then(() => turn);
		let approved = false, requested = false;
		const started = performance.now();
		try {
			await abortable(previous, signal);
			if (!await valid()) return { block: true, reason: "Approval cancelled or context changed. Nothing executed." };
			const asked = { kind: "ask" as const, reason: "AI security review", items: request.units.map(unit => ({ unit, reason: "Pending AI decision" })) };
			const discussion: { role: "assistant" | "user"; content: string }[] = [];
			let reply: ApprovalReply | undefined;
			for (;;) {
				const timeout = new AbortController();
				const timer = setTimeout(() => timeout.abort(), config.timeout_ms);
				const advisorSignal = AbortSignal.any([signal, timeout.signal]);
				const reviewStarted = performance.now();
				let card: ApprovalCard;
				try {
					const evidence = await abortable(collectApprovalEvidence(request, advisorSignal), advisorSignal);
					const conversation = approvalTaskContext(ctx);
					diagnostic({ phase: "advisor_start", model: config.model, contextCount: conversation.entries.length,
						evidenceCount: evidence.length + recent.length, discussionCount: discussion.length });
					card = await abortable(adviseApproval(request, asked, APPROVAL_OPTIONS, config, ctx,
						{ conversation, evidence: [...evidence, ...recent], discussion, signal: advisorSignal }), advisorSignal);
					diagnostic({ phase: "advisor_end", decision: card.decision ?? "missing", recommendation: card.recommendation, elapsedMs: performance.now() - reviewStarted });
				} catch (error) {
					const reason = timeout.signal.aborted ? "timeout" : error instanceof ApprovalAdvisorError ? error.reason : "unavailable";
					diagnostic({ phase: "advisor_failure", reason, elapsedMs: performance.now() - reviewStarted });
					recordDecision(ctx, "unavailable", "host", key, event.toolCallId);
					return { block: true, reason: `Approval unavailable: ${advisorFailureText(reason)}. Not executed; not a policy denial.` };
				} finally { clearTimeout(timer); timeout.abort(); }
				if (!await valid()) return { block: true, reason: "Approval context changed. Nothing executed." };
				if (card.decision === "deny") { reply = { choice: "Deny", actor: "advisor", feedback: card.explanation }; break; }
				if (card.decision === "allow" && discussion.length === 0) { reply = { choice: "Allow once", actor: "advisor", feedback: card.explanation }; break; }
				if (card.decision !== "ask" && card.decision !== "allow") throw new Error("Missing classifier decision");
				// ask 不因用户离开而转交模型自批；讨论也不能成为隐式批准。
				if (!requested) {
					requested = true;
					pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "requested", toolCallId: event.toolCallId, toolName: "approval" } satisfies ApprovalStatusEvent);
				}
				const opts = { signal, card, discuss: true };
				diagnostic({ phase: "present" });
				if (present && canPresent(ctx, present)) reply = await abortable(present.show(ctx.ui, request, asked, APPROVAL_OPTIONS, opts), signal);
				else if (ctx.hasUI) {
					const choice = await abortable(ctx.ui.select(`${card.title}\n${card.explanation}\n${formatApprovalPrompt(request, asked)}`, [...APPROVAL_OPTIONS], opts), signal);
					reply = choice === "Allow once" || choice === "Deny" ? { choice } : undefined;
				} else return { block: true, reason: "AI requested a human decision, but no interactive UI is available. Not executed." };
				if (!await valid()) return { block: true, reason: "Approval cancelled or context changed. Nothing executed." };
				if (reply?.choice !== "Discuss") break;
				if (!reply.feedback?.trim()) return { block: true, reason: "Empty clarification. Nothing executed." };
				discussion.push({ role: "assistant", content: card.explanation }, { role: "user", content: reply.feedback.slice(0, 2000) });
				if (discussion.length > 20) return { block: true, reason: "Clarification limit reached. Start a new user turn; nothing executed." };
			}
			if (!await valid()) return { block: true, reason: "Approval invalidated. Nothing executed." };
			approved = reply?.choice === "Allow once";
			const actor = reply?.actor ?? "user", outcome = approved ? "approved" : reply ? "rejected" : "cancelled";
			recordDecision(ctx, outcome, actor, key, event.toolCallId);
			diagnostic({ phase: "resolved", outcome, actor, scope: approved ? "once" : "", elapsedMs: performance.now() - started });
			if (!approved) return { block: true, reason: `${actor === "advisor" ? "AI denied" : "User rejected or cancelled"} this action.${reply?.feedback ? `\n${reply.feedback}` : ""} Do not retry unchanged without new evidence or user direction.` };
			if (reply?.feedback) feedback.set(event.toolCallId, { text: reply.feedback, actor });
			if ((request.tool === "webfetch" || request.tool === "http") && request.detail.addresses !== undefined)
				attachPrivateNetworkGrant(event.input, createPrivateNetworkGrantFor(request.detail.origin, request.detail.addresses));
		} catch {
			diagnostic({ phase: "invalidated", reason: "exception" });
			return { block: true, reason: "Approval cancelled or unavailable. Nothing executed." };
		} finally {
			if (requested) pi.events.emit(APPROVAL_STATUS_CHANNEL, { type: "resolved", toolCallId: event.toolCallId, outcome: approved ? "approved" : "denied" } satisfies ApprovalStatusEvent);
			release();
		}
	});
	pi.on("tool_result", event => {
		const newFile = pendingFiles.get(event.toolCallId);
		pendingFiles.delete(event.toolCallId);
		if (newFile && !event.isError) created.add(newFile);
		if (event.toolName !== "execute") {
			const input = { ...event.input };
			if ("env" in input) input.env = "values omitted";
			recent.push({ source: "tool", tool: event.toolName, id: event.toolCallId, outcome: event.isError ? "error" : "ok",
				input: boundedText(JSON.stringify(input), 12000),
				output: boundedText(event.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 4000),
				trust: "untrusted content; outcome is not a safety verdict or consent" });
			if (recent.length > 16) recent.shift();
		}
		const note = feedback.get(event.toolCallId); feedback.delete(event.toolCallId);
		if (note) return { content: [...event.content, { type: "text" as const, text: `Approval (${note.actor}, this action only; not new authorization):\n${note.text}` }] };
	});

	function recordDecision(ctx: ExtensionContext, decision: string, actor: string, requestHash: string, toolCallId: string): void {
		try { pi.appendEntry("approval_decision", { tool_call_id: toolCallId, request_hash: requestHash, decision, actor, scope: decision === "approved" ? "once" : "" }); }
		catch { ctx.ui.notify("审批已处理，但审计记录未保存。", "warning"); }
	}
}

/** 取消立即结束等待并释放监听器；迟到响应不能继续原调用。 */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("Approval cancelled"));
		if (signal.aborted) { pending.catch(() => {}); abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
