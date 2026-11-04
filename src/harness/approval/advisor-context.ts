import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 仅截取近期主模型可见文本，不发送思考、整个会话或认证信息。 */
export function approvalTaskContext(ctx: Pick<ExtensionContext, "sessionManager">): string[] {
	return ctx.sessionManager.getBranch().filter(entry => entry.type === "message")
		.slice(-6).flatMap(entry => {
			if (entry.type !== "message") return [];
			const message = entry.message;
			if (message.role !== "assistant" && message.role !== "user") return [];
			const text = typeof message.content === "string" ? message.content
				: message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
			return text ? [`${message.role}: ${text.slice(-1800)}`] : [];
		}).slice(-4);
}
