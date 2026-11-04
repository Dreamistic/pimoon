import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecutionTrace } from "../trace.ts";

export const CODEACT_EXECUTION = "pimoon:codeact-execution";
export function isCodeActExecutionEvent(value: unknown): value is CodeActExecutionEvent {
	if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string" || !("phase" in value)) return false;
	if (value.phase === "start") return "trace" in value && typeof value.trace === "object" && value.trace !== null;
	return value.phase === "end" && "isError" in value && typeof value.isError === "boolean" && "durationMs" in value && typeof value.durationMs === "number"
		&& "result" in value && typeof value.result === "object" && value.result !== null && "content" in value.result && Array.isArray(value.result.content);
}

export type CodeActExecutionEvent =
	| { phase: "start"; id: string; trace: ExecutionTrace }
	| { phase: "end"; id: string; result: AgentToolResult<unknown>; isError: boolean; durationMs: number };
