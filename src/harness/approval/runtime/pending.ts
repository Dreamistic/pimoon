import { createHash, randomUUID } from "node:crypto";
import type { ApprovalGateConfig, ApprovalRequest } from "../types.ts";

export interface ApprovalBinding { session: string; cwd: string; leaf: string | null }
export interface PendingApproval {
	id: string;
	key: string;
	policy: string;
	request: ApprovalRequest;
	binding: ApprovalBinding;
	expires: number;
	state: "pending" | "presenting" | "approved" | "closed";
}

/** 仅保存当前任务的提案和一次性票据；恢复历史或模型自造 ID 都不能恢复权限。 */
export class PendingApprovals {
	private requests = new Map<string, PendingApproval>();
	clear(): void { this.requests.clear(); }
	defer(request: ApprovalRequest, input: unknown, config: ApprovalGateConfig, binding: ApprovalBinding): PendingApproval {
		const key = requestKey(request, input), policy = approvalFingerprint(config);
		for (const item of this.requests.values()) {
			if (item.expires <= Date.now()) this.requests.delete(item.id);
			else if (item.key === key && item.policy === policy && item.binding.session === binding.session && item.binding.cwd === binding.cwd) return item;
		}
		if (this.requests.size >= 128) {
			const oldest = this.requests.keys().next().value;
			if (oldest) this.requests.delete(oldest);
		}
		const item: PendingApproval = { id: randomUUID(), key, policy, request: structuredClone(request), binding,
			expires: Date.now() + 30 * 60_000, state: "pending" };
		this.requests.set(item.id, item);
		return item;
	}
	claim(id: string): PendingApproval | undefined {
		const item = this.requests.get(id);
		if (!item || item.state !== "pending" || !this.active(item)) return;
		item.state = "presenting";
		return item;
	}
	active(item: PendingApproval): boolean { return this.requests.get(item.id) === item && item.expires > Date.now(); }
	finish(item: PendingApproval, outcome: "once" | "granted" | "closed"): void {
		if (!this.active(item)) return;
		if (outcome === "granted") this.requests.delete(item.id);
		else item.state = outcome === "once" ? "approved" : "closed";
	}
	closed(request: ApprovalRequest, input: unknown, binding: ApprovalBinding): boolean {
		const key = requestKey(request, input);
		return [...this.requests.values()].some(item => item.state === "closed" && item.key === key && item.binding.session === binding.session && item.binding.cwd === binding.cwd);
	}
	consume(request: ApprovalRequest, input: unknown, config: ApprovalGateConfig, binding: ApprovalBinding): boolean {
		const key = requestKey(request, input), policy = approvalFingerprint(config);
		for (const item of this.requests.values()) {
			if (item.key !== key || item.policy !== policy || item.binding.session !== binding.session || item.binding.cwd !== binding.cwd) continue;
			if (item.state !== "approved" || !this.active(item)) return false;
			this.requests.delete(item.id);
			return true;
		}
		return false;
	}
}

function requestKey(request: ApprovalRequest, input: unknown): string {
	// 宿主按剩余预算裁剪进程 timeout；预算变化不是新的操作，argv/cwd/env 仍严格绑定。
	const parameters = request.tool === "process_run" && typeof input === "object" && input !== null && !Array.isArray(input)
		? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "timeout")) : input;
	return approvalFingerprint([request, parameters]);
}
export function approvalFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => {
		if (item instanceof RegExp) return { source: item.source, flags: item.flags };
		if (typeof item === "object" && item !== null && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
		return item;
	})).digest("hex");
}
