import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ApprovalConversationEntry {
	id: string;
	role: string;
	content: string;
	truncated: boolean;
}

/** 限长保留两端，明确暴露信息缺失；不把中间删节伪装成完整文本。 */
export function boundedText(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const half = Math.floor(limit / 2);
	return { text: `${text.slice(0, half)}\n[omitted]\n${text.slice(-half)}`, truncated: true };
}

/** 不发送思考和认证对象。保留用户边界及其前置提案；工具内容保持不可信来源。 */
export function approvalTaskContext(ctx: Pick<ExtensionContext, "sessionManager">) {
	const entries: ApprovalConversationEntry[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === "approval_decision") {
			entries.push({ id: entry.id, role: "host_decision", content: JSON.stringify(entry.data), truncated: false });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" && message.role !== "user" && message.role !== "toolResult") continue;
		const text = typeof message.content === "string" ? message.content : message.content.flatMap(part => {
			if (part.type === "text") return [part.text];
			if (part.type === "toolCall") return [JSON.stringify({ tool: part.name, id: part.id, arguments: part.arguments })];
			return [];
		}).join("\n");
		const bounded = boundedText(text, message.role === "toolResult" ? 6000 : 12000);
		entries.push({ id: entry.id, role: message.role,
			content: message.role === "toolResult" ? JSON.stringify({ tool: message.toolName, id: message.toolCallId,
				outcome: message.isError ? "error" : "ok", output: bounded.text }) : bounded.text, truncated: bounded.truncated });
	}
	// 先保留用户和相邻提案，再填近期动作；预算不足明确报告，不能自动补造授权。
	const selected = new Set<number>();
	let remaining = 96000;
	const add = (index: number) => {
		const item = entries[index];
		if (!item || selected.has(index) || item.content.length > remaining) return;
		remaining -= item.content.length; selected.add(index);
	};
	for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.role === "user") { add(i); if (entries[i - 1]?.role === "assistant") add(i - 1); }
	for (let i = entries.length - 1; i >= 0; i--) add(i);
	return { entries: [...selected].sort((a, b) => a - b).map(i => entries[i]),
		omittedEntries: entries.length - selected.size, truncated: entries.some(item => item.truncated) || entries.length !== selected.size };
}
