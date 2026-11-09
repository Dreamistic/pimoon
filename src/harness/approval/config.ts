import { CONFIG_DEFINITIONS, ConfigError, loadValidatedMergedConfig } from "../config-loader.ts";
import type { ApprovalGateConfig } from "./types.ts";

export async function loadApprovalGateConfig(): Promise<ApprovalGateConfig> {
	const { merged } = await loadValidatedMergedConfig<ApprovalGateConfig>(CONFIG_DEFINITIONS.approvalGate, process.cwd());
	if (typeof merged.enabled !== "boolean" || !merged.model || !Number.isFinite(merged.timeout_ms))
		throw new ConfigError("approval-ai config is incomplete.");
	return merged;
}
