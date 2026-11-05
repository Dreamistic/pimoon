import type { CodeActMessage } from "../../../../../pimoon/codeact/transcript.ts";
import { responseUsageStatus } from "../../../../../pimoon/usage-status.ts";

export function replyMetrics(messages: CodeActMessage[]) {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
	for (const message of messages) {
		input += message.usage.input;
		output += message.usage.output;
		cacheRead += message.usage.cacheRead;
		cacheWrite += message.usage.cacheWrite;
		cost += message.usage.cost.total;
	}
	return { input, output, cacheRead, cacheWrite, cost, usageIncomplete: messages.some(message => responseUsageStatus(message) !== "complete") };
}
