import type { ApprovalStatusEvent } from "../approval/events.ts";

/** 审批是调用墙钟的子区间，不与 SDK 执行耗时相加（审批工具可在 execute 内等待）。 */
export class CallTiming {
	private approvalStarted: number | undefined;
	private approvalMs = 0;
	private observed = false;

	constructor(private readonly started = performance.now()) {}

	approval(event: ApprovalStatusEvent, at = performance.now()): void {
		if (event.type === "requested") {
			this.observed = true;
			this.approvalStarted ??= at;
		} else if (this.approvalStarted !== undefined) {
			this.approvalMs += at - this.approvalStarted;
			this.approvalStarted = undefined;
		}
	}

	finish(at = performance.now()) {
		return {
			wall_ms: at - this.started,
			...(this.observed ? {
				approval_wait_ms: this.approvalMs + (this.approvalStarted === undefined ? 0 : at - this.approvalStarted),
				approval_wait_complete: this.approvalStarted === undefined,
			} : {}),
		};
	}
}

export function processDuration(tool: string, details: unknown): number | undefined {
	if (tool !== "process_run" || typeof details !== "object" || details === null || !("duration_ms" in details)) return undefined;
	const value = details.duration_ms;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
