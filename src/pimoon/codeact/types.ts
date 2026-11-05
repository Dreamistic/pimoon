import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CodeActMetadata } from "./metadata.ts";

export const CODEACT_RESULT = "codeact_result";

export interface CodeActMessage extends AssistantMessage {
	codeact?: CodeActMetadata & { id: string; index: number; complete: boolean };
	codeactContent?: AssistantMessage["content"];
	codeactStop?: { sequence: "</execute>"; usage: "complete" | "partial" | "unavailable" };
}

export interface CodeActResult {
	id: string;
	isError: boolean;
	durationMs: number;
	metrics: Record<string, unknown>;
	/** 仅用于上下文投影；原始会话结果不改写。 */
	pruned?: true;
	nestedCalls?: NonNullable<ToolResultMessage["nestedCalls"]>;
}

export function isCodeActResultMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "custom" }> & { details: CodeActResult } {
	return message.role === "custom" && message.customType === CODEACT_RESULT && isCodeActResult(message.details);
}

export function codeactSource(message: CodeActMessage): string | undefined {
	const block = message.codeact && message.content[message.codeact.index];
	return block?.type === "text" ? block.text : undefined;
}

export function isCodeActResult(value: unknown): value is CodeActResult {
	return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
		&& "isError" in value && typeof value.isError === "boolean" && "durationMs" in value && typeof value.durationMs === "number"
		&& "metrics" in value && typeof value.metrics === "object" && value.metrics !== null;
}
