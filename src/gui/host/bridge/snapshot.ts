import { stat } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiSession } from "../session/session.ts";
import type { BridgeState, BridgeTask, BridgeTaskView } from "./schema.ts";
import { missing } from "./files.ts";

export function taskState(task: BridgeTask, exists: boolean, activity: string): BridgeState {
	if (!exists) return "lost";
	if (task.verdict?.verdict === "accepted") return "accepted";
	if (task.cancelled) return "cancelled";
	if (activity === "loading" || activity === "running") return "running";
	if (activity === "waiting") return "waiting";
	if (task.delivery && !task.verdict) return "delivered";
	return "stalled";
}
export async function taskSnapshot(task: BridgeTask, session: GuiSession | undefined): Promise<BridgeTaskView> {
	let exists: boolean;
	try { exists = (await stat(task.sessionFile)).isFile(); } catch (error) { if (!missing(error)) throw error; exists = false; }
	const state = taskState(task, exists, session?.activity.state ?? "idle");
	const dialogs = state === "waiting" ? (session?.execution?.dialogs.list() ?? []).map(dialog =>
		dialog.kind === "secret" || dialog.kind === "editor" ? { ...dialog, initial: "", message: "Owner response required.", options: [] } : dialog) : [];
	if (state !== "stalled") return { ...task, state, dialogs };
	const manager = session?.execution?.ready ? session.execution.runtime.session.sessionManager : SessionManager.open(task.sessionFile);
	if (manager.getSessionId() !== task.id) throw new Error("委派会话文件已被替换。");
	const message = manager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
	const lastAssistant = message?.type === "message" && message.message.role === "assistant"
		? (message.message.content.filter(block => block.type === "text").map(block => block.text).join("\n") || message.message.errorMessage || "").slice(0, 2000) : "";
	return { ...task, state, dialogs, lastAssistant };
}
