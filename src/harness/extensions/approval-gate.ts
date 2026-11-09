import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { grantRoutineInspection } from "../approval/routine-file-grant.ts";
import { routineOperation } from "../approval/routine.ts";
import { grantRoutineProcess } from "../approval/routine-process-grant.ts";
import { loadApprovalGateConfig } from "../approval/config.ts";
import { approvalFingerprint } from "../approval/runtime/pending.ts";
import { approvalBinding, type ApprovalPresenter } from "../approval/pi/proposal.ts";
import { approvalDiagnostic } from "../approval/diagnostics.ts";
import { boundedText } from "../approval/advisor-context.ts";
import { buildApprovalRequest, isApprovalToolCall } from "../approval/pi/request.ts";
import { appendApprovalTrace } from "../approval/trace-store.ts";
import { currentApprovalBlock, blockPlan, operationKey, stopApprovalBlock } from "../approval/block.ts";
import { abortable, reviewOperation } from "../approval/review.ts";
import { attachPrivateNetworkGrant, createPrivateNetworkGrantFor } from "../web-tools/network/private-network-grant.ts";

export type { ApprovalPresenter } from "../approval/pi/proposal.ts";

/** 常规操作不触发模型；首次升级时整段审查，并发子调用共享同一决定。 */
export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter): void {
	let lifetime = new AbortController(), queue: Promise<void> = Promise.resolve();
	const recent: unknown[] = [], created = new Set<string>(), pendingFiles = new Map<string, string>();
	const feedback = new Map<string, { reason: string; actor: string }>();
	const traceCalls = new Map<string, { reviewId: string; config: NonNullable<Awaited<ReturnType<typeof loadApprovalGateConfig>>["diagnostics"]> }>();
	const reset = () => { lifetime.abort(); lifetime = new AbortController(); feedback.clear(); created.clear(); pendingFiles.clear(); traceCalls.clear(); };
	pi.on("before_agent_start", reset);
	pi.on("session_start", () => { reset(); recent.length = 0; });
	pi.on("session_tree", () => { reset(); recent.length = 0; });
	pi.on("session_shutdown", reset);
	pi.on("tool_call", async (event, ctx) => {
		if (!isApprovalToolCall(event)) return;
		const session = ctx.sessionManager.getSessionId(), block = currentApprovalBlock(session, event.parentToolCallId);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
		const binding = approvalBinding(ctx), inputHash = approvalFingerprint(event.input);
		const opKey = operationKey(event.toolName, event.input, ctx.cwd);
		let config, request;
		try { config = await loadApprovalGateConfig(); if (!config.enabled) {
			if (block?.verdict) { stopApprovalBlock(block, "Approval configuration changed during this CodeAct. Start a new block."); return { block: true, reason: "CodeAct approval invalidated." }; }
			return;
		} request = await buildApprovalRequest(event, ctx.cwd); }
		catch { return { block: true, reason: "Approval configuration or request inspection failed. Nothing executed." }; }
		if (!request) return { block: true, reason: "Approval could not inspect this request. Nothing executed." };
		const hash = approvalFingerprint(request), policyHash = approvalFingerprint(config);
		const valid = async () => !signal.aborted && approvalBinding(ctx) === binding && approvalFingerprint(event.input) === inputHash
			&& approvalFingerprint(await loadApprovalGateConfig()) === policyHash;
		const stop = (reason: string) => { if (block) stopApprovalBlock(block, reason); return { block: true as const, reason }; };
		if (block?.stopReason) return stop(block.stopReason);
		if (block?.result && (!block.result.allowed || block.result.policyHash !== policyHash)) return stop("CodeAct approval was denied or invalidated. Start a new block; nothing further executed.");
		const started = performance.now();
		let category: string | undefined;
		try { category = config.routine !== false ? await routineOperation(request, ctx.cwd, created) : undefined; } catch { /* 未知操作继续 AI。 */ }
		// 其他子项正在等待整段审批时，不让并发的免审调用从等待旁边穿过。
		if (category && !block?.verdict) {
			try {
				if (request.tool === "process_run") await grantRoutineProcess(event.input, ctx.cwd, category);
				if (category === "local_inspection") await grantRoutineInspection(event.input, ctx.cwd);
				if (!await valid()) return stop("Approval context changed. Nothing executed.");
				if (category === "project_new_file" && request.tool === "write") pendingFiles.set(event.toolCallId, request.detail.path);
				if (block) block.seen.set(opKey, (block.seen.get(opKey) ?? 0) + 1);
				approvalDiagnostic(session, event.toolCallId, hash, request.tool, { phase: "routine", category, elapsedMs: performance.now() - started });
				return;
			} catch { if (signal.aborted) return stop("Approval cancelled. Nothing executed."); }
		}
		const review = async () => {
			const reviewId = new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomUUID();
			const previous = queue; let release = () => {};
			const turn = new Promise<void>(resolve => { release = resolve; }); queue = previous.then(() => turn);
			try {
				await abortable(previous, signal);
				if (!await valid()) return { allowed: false, reason: "Approval context changed. Nothing executed.", actor: "host" as const, outcome: "cancelled", reviewId, policyHash };
				if (block && block.code.length > 96000) return { allowed: false, reason: "CodeAct exceeds the complete-review limit. Split it into smaller blocks before requesting approval; no remaining operations executed.", actor: "host" as const, outcome: "unavailable", reviewId, policyHash };
				const plan = block ? await blockPlan(block, signal) : undefined;
				if (block && plan) {
					block.remaining = new Map();
					for (const item of plan.calls) { const key = operationKey(item.tool, item.input, ctx.cwd); block.remaining.set(key, (block.remaining.get(key) ?? 0) + 1); }
					for (const [key, count] of block.seen) block.remaining.set(key, Math.max(0, (block.remaining.get(key) ?? 0) - count));
					if (!block.remaining.get(opKey)) block.remaining.set(opKey, 1);
				}
				const result = await reviewOperation({ pi, ctx, request, config, callId: event.toolCallId, hash, reviewId, signal, valid,
					evidence: [...recent], ...(present ? { presenter: present } : {}), ...(block ? { block } : {}), ...(plan ? { plan } : {}) });
				try { pi.appendEntry("approval_decision", { tool_call_id: event.toolCallId, code_call_id: block?.id, request_hash: hash, review_id: reviewId,
					decision: result.outcome, actor: result.actor, scope: result.allowed ? block ? "codeact" : "once" : "" }); } catch { ctx.ui.notify("审批已处理，但审计未保存。", "warning"); }
				return { ...result, policyHash };
			} finally { release(); }
		};
		try {
			const result = block ? await (block.verdict ??= review()) : await review();
			if (block) {
				block.result = result;
				if (config.diagnostics) traceCalls.set(block.id, { reviewId: result.reviewId, config: config.diagnostics });
			}
			if (!result.allowed) return stop(result.reason);
			if (signal.aborted || approvalFingerprint(event.input) !== inputHash || approvalFingerprint(await loadApprovalGateConfig()) !== result.policyHash)
				return stop("CodeAct approval changed or cancelled. Nothing further executed.");
			if (block) {
				const count = block.remaining?.get(opKey) ?? 0;
				if (!count && !category) return stop("This dynamic operation was not covered by the reviewed CodeAct plan. Start a new block with resolved parameters; no additional approval was requested.");
				if (count) block.remaining?.set(opKey, count - 1);
			}
			if (category && request.tool === "process_run") await grantRoutineProcess(event.input, ctx.cwd, category);
			if (category === "local_inspection") await grantRoutineInspection(event.input, ctx.cwd);
			if (signal.aborted) return stop("CodeAct cancelled. Nothing further executed.");
			feedback.set(event.toolCallId, { reason: result.reason, actor: "actor" in result ? String(result.actor) : "advisor" });
			if (config.diagnostics) {
				traceCalls.set(event.toolCallId, { reviewId: result.reviewId, config: config.diagnostics });
				void appendApprovalTrace(result.reviewId, "dispatch", { callId: event.toolCallId, blockId: block?.id, tool: event.toolName, input: event.input }, config.diagnostics).catch(() => approvalDiagnostic(session, event.toolCallId, hash, request.tool, { phase: "trace_failure" }));
			}
			if (signal.aborted || approvalFingerprint(event.input) !== inputHash) return stop("CodeAct cancelled or input changed before dispatch.");
			if ((request.tool === "webfetch" || request.tool === "http") && request.detail.addresses !== undefined)
				attachPrivateNetworkGrant(event.input, createPrivateNetworkGrantFor(request.detail.origin, request.detail.addresses));
		} catch { return stop("Approval cancelled or unavailable. Nothing further executed."); }
	});
	pi.on("tool_result", async event => {
		const trace = traceCalls.get(event.toolCallId); traceCalls.delete(event.toolCallId);
		if (trace) void appendApprovalTrace(trace.reviewId, "execution", { tool: event.toolName, callId: event.toolCallId,
			outcome: event.isError ? "error" : "ok", output: event.content.filter(part => part.type === "text").map(part => part.text).join("\n") }, trace.config).catch(() => {});
		const file = pendingFiles.get(event.toolCallId); pendingFiles.delete(event.toolCallId); if (file && !event.isError) created.add(file);
		if (event.toolName !== "execute") {
			const input = { ...event.input }; if ("env" in input) input.env = "values omitted";
			recent.push({ source: "tool", tool: event.toolName, id: event.toolCallId, outcome: event.isError ? "error" : "ok", input: boundedText(JSON.stringify(input), 12000),
				output: boundedText(event.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 4000), trust: "untrusted content; not consent" });
			if (recent.length > 16) recent.shift();
		}
		const note = feedback.get(event.toolCallId); feedback.delete(event.toolCallId);
		if (note) return { content: [...event.content, { type: "text" as const, text: `Approval (${note.actor}, reviewed CodeAct/action only; not new authorization):\n${note.reason}` }] };
	});
}
