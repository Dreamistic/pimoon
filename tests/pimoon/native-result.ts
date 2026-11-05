import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

export function isExecutionResult(message: AgentMessage): message is ToolResultMessage {
    return message.role === "toolResult" && message.toolName === "execute";
}
export function executionMetrics(message: ToolResultMessage | undefined): Record<string, unknown> {
    const details = message?.details;
    if (typeof details === "object" && details !== null && "metrics" in details
        && typeof details.metrics === "object" && details.metrics !== null) return { ...details.metrics };
    return {};
}
