import { evaluateGatePolicy } from "../rules/policy.ts";
import { ApprovalStores, type SessionApprovalRules } from "../rules/store.ts";
import type { ApprovalDecision, ApprovalGateConfig, ApprovalRequest } from "../types.ts";
import { handleAskDecision, type ApprovalDialogOptions, type ApprovalOutcome, type ApprovalInteractionPort } from "./interaction.ts";

export function createApprovalGate(stores = new ApprovalStores(), sessionRules: SessionApprovalRules = { rules: [] }) {
	const open = async (config: ApprovalGateConfig) => {
		const file = await stores.open(config.remember.persistent_store);
		await file.refresh();
		return file.forSession(sessionRules);
	};
	return {
		async inspect(request: ApprovalRequest, config: ApprovalGateConfig): Promise<ApprovalDecision> {
			if (!config.enabled) return { kind: "allow" };
			return evaluateGatePolicy(request, config, await open(config));
		},
		async authorize(request: ApprovalRequest, config: ApprovalGateConfig, interaction?: ApprovalInteractionPort, opts?: ApprovalDialogOptions): Promise<ApprovalOutcome> {
			if (!config.enabled) return { kind: "approved" };
			const store = await open(config);
			const decision = evaluateGatePolicy(request, config, store);
			if (decision.kind === "allow") return { kind: "approved" };
			if (decision.kind === "deny") return blockForDenyRule(decision);
			if (interaction === undefined) return config.ui.non_interactive === "allow" ? { kind: "approved" }
				: { kind: "blocked", reason: `Approval required but no interactive UI is available: ${decision.reason}` };
			return handleAskDecision(request, decision, config, store, interaction, opts);
		},
	};
}

export function blockForDenyRule(decision: Extract<ApprovalDecision, { kind: "deny" }>): ApprovalOutcome & { kind: "blocked" } {
	const source = decision.rule_name === undefined ? "Approval Gate" : `Approval Gate rule "${decision.rule_name}"`;
	return { kind: "blocked", reason: `Blocked by ${source}: ${decision.reason}. Deny rule; no approval prompt.` };
}
