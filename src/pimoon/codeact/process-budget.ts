export const DEFAULT_PROCESS_TIMEOUT_SECONDS = 300;
export const MAX_PROCESS_TIMEOUT_SECONDS = 1800;
const CLEANUP_RESERVE_MS = 5000;

/** 为进程树回收及 Python 接收错误预留时间，不用外层取消代替命令超时。 */
export function limitProcessTimeout(input: unknown, remainingMs: number): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	const requested = "timeout" in input ? input.timeout : DEFAULT_PROCESS_TIMEOUT_SECONDS;
	// 无效参数留给工具 schema 拒绝，不能通过裁剪变成有效调用。
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0 || requested > MAX_PROCESS_TIMEOUT_SECONDS) return input;
	const available = (remainingMs - CLEANUP_RESERVE_MS) / 1000;
	if (available <= 0) throw new Error("CodeAct budget nearly exhausted; run subprocess.run in a new block.");
	return requested > available ? { ...input, timeout: available } : input;
}
