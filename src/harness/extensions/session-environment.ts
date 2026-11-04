import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureSessionEnvironment } from "../session-environment.ts";

const CONTEXT = "pimoon-session-environment";

/** 每次会话打开或恢复只采集一次，不修改 system prompt 前缀或每轮重复追加。 */
export default function sessionEnvironment(pi: ExtensionAPI): void {
	let controller = new AbortController(), pending: Promise<string> | undefined;
	pi.on("session_start", (_event, ctx) => {
		controller.abort(); controller = new AbortController();
		pending = undefined;
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		pending = captureSessionEnvironment(ctx.cwd, controller.signal).catch(() => "");
	});
	pi.on("context", async (event, ctx) => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		const active = controller;
		pending ??= captureSessionEnvironment(ctx.cwd, active.signal).catch(() => "");
		const text = await pending;
		if (!text || active.signal.aborted) return;
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === CONTEXT));
		return { messages: [{ role: "custom" as const, customType: CONTEXT, content: text, display: false, timestamp: 0 }, ...messages] };
	});
	pi.on("session_shutdown", () => { controller.abort(); pending = undefined; });
}
