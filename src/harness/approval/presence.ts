export interface ApprovalPresence { state: "active" | "away" | "unknown"; idleSeconds?: number }
let latest: { value: ApprovalPresence; at: number } | undefined;

/** 仅使用桌面宿主报告的系统空闲秒数，不采集窗口标题、进程或键盘内容。 */
export function updateApprovalPresence(idleSeconds: number): void {
	if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return;
	latest = { value: { state: idleSeconds >= 180 ? "away" : "active", idleSeconds }, at: Date.now() };
}
export function approvalPresence(): ApprovalPresence {
	return latest && Date.now() - latest.at < 30_000 ? latest.value : { state: "unknown" };
}
