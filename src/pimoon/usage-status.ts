import type { CodeActMessage } from "./codeact/types.ts";

export type UsageStatus = "complete" | "partial" | "unavailable";

/** 纯状态判断可供 GUI 使用，不加载分词器或初始化配置。 */
export function responseUsageStatus(message: CodeActMessage): UsageStatus {
	if (message.codeactStop) return message.codeactStop.usage;
	if (!Number.isFinite(message.usage.totalTokens) || message.usage.totalTokens <= 0) return "unavailable";
	return ["error", "aborted", "pending"].includes(message.stopReason) ? "partial" : "complete";
}
