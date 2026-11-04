import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadApprovalGateConfig } from "../approval/config.ts";
import { createApprovalGate, blockForDenyRule } from "../approval/runtime/gate.ts";
import { approvalOptions, approvalScopes } from "../approval/runtime/interaction.ts";
import { PendingApprovals } from "../approval/runtime/pending.ts";
import { approvalBinding, registerApprovalProposal, type ApprovalPresenter } from "../approval/pi/proposal.ts";
import { buildApprovalRequest, isApprovalToolCall } from "../approval/pi/request.ts";
import { buildBashApprovalRequest } from "../approval/request/bash/parse.ts";
import { formatBashPolicyEvaluation } from "../approval/rules/bash-facts.ts";
import { evaluateBashGatePolicy } from "../approval/rules/policy.ts";
import { attachPrivateNetworkGrant, createPrivateNetworkGrantFor } from "../web-tools/network/private-network-grant.ts";

export type { ApprovalPresenter } from "../approval/pi/proposal.ts";
export default function approvalGateExtension(pi: ExtensionAPI, present?: ApprovalPresenter, gate = createApprovalGate()): void {
	const pending = new PendingApprovals();
	registerApprovalProposal(pi, gate, pending, present);
	pi.on("before_agent_start", () => pending.clear());
	pi.on("session_start", () => pending.clear());
	pi.on("session_tree", () => pending.clear());
	pi.on("session_shutdown", () => pending.clear());
	pi.registerCommand("approval-check", {
		description: "Explain the Bash gate decision without executing the command.",
		async handler(args, ctx) {
			const command = args.trim();
			if (!command) { ctx.ui.notify("Usage: /approval-check <bash command>", "warning"); return; }
			const [config, request] = await Promise.all([loadApprovalGateConfig(), buildBashApprovalRequest(command, ctx.cwd)]);
			const evaluation = evaluateBashGatePolicy(request, config, { matchesAllowRule: () => false });
			const decision = config.enabled ? evaluation.decision : { kind: "allow" as const };
			ctx.ui.notify(formatBashPolicyEvaluation(evaluation.bash, decision), decision.kind === "deny" ? "warning" : "info");
		},
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!isApprovalToolCall(event)) return;
		const config = await loadApprovalGateConfig();
		if (!config.enabled) return;
		const request = await buildApprovalRequest(event, ctx.cwd);
		if (!request) return;
		const binding = approvalBinding(ctx);
		if (pending.closed(request, event.input, binding)) return { block: true, reason: "Approval closed for this operation. Wait for a new user instruction; do not bypass or re-prompt." };
		const once = pending.consume(request, event.input, config, binding);
		const decision = await gate.inspect(request, config, once);
		if (decision.kind === "deny") return { block: true, reason: blockForDenyRule(decision).reason };
		if (decision.kind === "ask") {
			if (!ctx.hasUI) {
				if (config.ui.non_interactive !== "allow") return { block: true, reason: `Approval required but no interactive UI is available: ${decision.reason}` };
			} else {
				const item = pending.defer(request, event.input, config, binding);
				return { block: true, reason: JSON.stringify({ status: "approval_required", request_id: item.id, tool: request.tool, cwd: request.cwd, reason: decision.reason,
					scopes: approvalScopes(request, decision, approvalOptions(config, decision)).map(({ scope, detail }) => ({ scope, detail })),
					next: "Call approval(request_id=..., reason=..., scope=...) with your rationale. This call did not run; earlier effects remain completed." }) };
			}
		}
		if (request.tool === "webfetch" || request.tool === "http") attachPrivateNetworkGrant(event.input, createPrivateNetworkGrantFor(request.detail.origin, request.detail.addresses));
	});
}
