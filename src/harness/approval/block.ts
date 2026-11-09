import path from "node:path";
import { approvalFingerprint } from "./runtime/pending.ts";
import { inspectBlockPlan, type BlockPlan } from "./block-plan.ts";

export interface BlockVerdict { allowed: boolean; reason: string; policyHash: string; reviewId: string }
export interface ApprovalBlock {
	id: string; session: string; cwd: string; code: string; codeHash: string;
	controller: AbortController;
	plan?: Promise<BlockPlan>;
	verdict?: Promise<BlockVerdict>;
	result?: BlockVerdict;
	stopReason?: string;	notified?: boolean;
	remaining?: Map<string, number>;
	seen: Map<string, number>;
}
const active = new Map<string, ApprovalBlock>();

export function beginApprovalBlock(session: string, id: string, cwd: string, code: string): ApprovalBlock {
	if (active.has(session)) throw new Error("CodeAct block is already active.");
	const block: ApprovalBlock = { session, id, cwd, code, codeHash: approvalFingerprint(code), controller: new AbortController(), seen: new Map() };
	active.set(session, block); return block;
}
export function currentApprovalBlock(session: string, parentId: string | undefined): ApprovalBlock | undefined {
	const block = active.get(session);
	return block?.id === parentId ? block : undefined;
}
export function endApprovalBlock(block: ApprovalBlock): void { if (active.get(block.session) === block) active.delete(block.session); }
export function stopApprovalBlock(block: ApprovalBlock, reason: string): void { block.stopReason = reason; block.controller.abort(); }
export function blockPlan(block: ApprovalBlock, signal: AbortSignal): Promise<BlockPlan> {
	return block.plan ??= inspectBlockPlan(block.code, block.cwd, signal);
}

/** 批次许可只覆盖宿主从本段源码提取的确定参数和触发时实际参数，不外推到动态新目标。 */
export function operationKey(tool: string, input: Record<string, unknown>, cwd: string): string {
	const value = { ...input };
	if (tool === "process_run") return approvalFingerprint({ tool, argv: value.argv,
		cwd: path.resolve(cwd, typeof value.cwd === "string" ? value.cwd : "."), env: value.env ?? {}, inherit: value.inherit_env !== false });
	if (["read", "write", "edit", "ls"].includes(tool) && typeof value.path === "string" && !value.path.includes("://")) value.path = path.resolve(cwd, value.path);
	return approvalFingerprint({ tool, input: value });
}
