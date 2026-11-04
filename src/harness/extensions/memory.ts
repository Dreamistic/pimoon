import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pimoonHome } from "../../pimoon/profile.ts";
import { CONFIG_DEFINITIONS, loadValidatedMergedConfig } from "../config-loader.ts";
import { MEMORY_CONTEXT, MEMORY_POLICY, memoryContext } from "../memory/context.ts";
import { MemoryStore } from "../memory/store.ts";
import { manageMemory } from "../memory/manage.ts";

export default function memory(pi: ExtensionAPI): void {
	const store = new MemoryStore(path.join(pimoonHome, "memory"));
	const observed = new Map<string, string>();
	let enabled = true, session: string | undefined, lastNotice = "", lastSnapshot = "";
	const main = process.env.PI_SUBAGENT_CHILD !== "1";
	pi.registerCommand("memory", { description: "Browse, edit, archive or delete local memories.", handler: (_args, ctx) => manageMemory(store, ctx) });
	pi.on("before_agent_start", async (event, ctx) => {
		if (!main) return;
		try { enabled = (await loadValidatedMergedConfig<{ enabled: boolean }>(CONFIG_DEFINITIONS.memory, ctx.cwd)).merged.enabled; }
		catch { enabled = false; ctx.ui.notify("记忆配置无效，已暂停自动记忆。", "warning"); }
		event.systemPromptOptions.sections ??= {};
		event.systemPromptOptions.sections.memory_policy = enabled ? MEMORY_POLICY : "Auto memory is disabled. Do not automatically load or save memories.";
	});
	pi.on("context", async (event, ctx) => {
		const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === MEMORY_CONTEXT));
		if (!main || !enabled) return { messages };
		if (session !== ctx.sessionManager.getSessionId()) { session = ctx.sessionManager.getSessionId(); observed.clear(); lastSnapshot = ""; }
		try {
			const snapshot = await store.snapshot(ctx.cwd, ctx.signal);
			let invalidated = false;
			for (const [file, version] of observed) {
				const entry = snapshot.entries.find(entry => entry.path === file);
				if (!entry || entry.archived || entry.version !== version) { invalidated = true; observed.delete(file); }
			}
			const text = memoryContext(snapshot, invalidated);
			if (lastSnapshot !== snapshot.version) {
				pi.appendEntry("memory_snapshot", { version: snapshot.version, index: text });
				lastSnapshot = snapshot.version;
			}
			if (snapshot.issues.length && lastNotice !== snapshot.version) {
				lastNotice = snapshot.version;
				ctx.ui.notify(`${snapshot.issues.length} 条记忆无效或索引待重建；使用 /memory 查看。`, "warning");
			}
			return { messages: [{ role: "custom" as const, customType: MEMORY_CONTEXT, content: text, display: false, timestamp: 0 }, ...messages] };
		} catch {
			if (ctx.signal?.aborted) return { messages };
			if (lastNotice !== "unavailable") { lastNotice = "unavailable"; ctx.ui.notify("记忆暂不可用，任务可继续。请检查记忆目录。", "warning"); }
			return { messages: [{ role: "custom" as const, customType: MEMORY_CONTEXT, content: "Memory unavailable. Continue without assuming previous memories were loaded.", display: false, timestamp: 0 }, ...messages] };
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!["write", "edit"].includes(event.toolName) || !("path" in event.input) || typeof event.input.path !== "string") return;
		const file = path.resolve(ctx.cwd, event.input.path);
		if (!inside(store.root, file)) return;
		if (path.basename(file).toLowerCase() === "memory.md" || path.relative(store.root, file).toLowerCase() === "projects.json")
			return { block: true, reason: "Generated memory metadata. Edit entries/<topic>.md instead; the index is rebuilt automatically." };
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!main || !enabled || event.isError || typeof event.input.path !== "string") return;
		if (!["read", "write", "edit"].includes(event.toolName)) return;
		const file = path.resolve(ctx.cwd, event.input.path);
		if (!inside(store.root, file) || path.basename(path.dirname(file)).toLowerCase() !== "entries" || !file.endsWith(".md")) return;
		try {
			const snapshot = await store.snapshot(ctx.cwd, ctx.signal);
			const entry = snapshot.entries.find(entry => entry.path === file);
			const details: unknown = event.details;
			if (path.basename(path.dirname(file)).toLowerCase() === "entries" && details && typeof details === "object") {
				const version = "version" in details ? details.version : "after_version" in details ? details.after_version : "new_version" in details ? details.new_version : undefined;
				if (typeof version === "string") observed.set(file, version);
			}
			if (event.toolName === "read") return;
			pi.appendEntry("memory_change", { path: file, version: entry?.version, toolCallId: event.toolCallId });
			const issue = snapshot.issues.find(issue => issue.file === file || issue.file === path.join(path.dirname(path.dirname(file)), "MEMORY.md"));
			ctx.ui.notify(issue ? "记忆已保存，但未进入索引。" : "记忆已更新。", issue ? "warning" : "info");
			const note = issue ? `Memory saved; ${issue.reason}` : `Memory saved; ${entry ? entry.archived ? "archived" : "indexed" : "index_pending (outside current scopes)"}.`;
			return { content: [...event.content, { type: "text" as const, text: note }],
				...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
		} catch {
			return { content: [...event.content, { type: "text" as const, text: "Memory file saved; index_pending. Do not repeat the write." }],
				...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
		}
	});
}
function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
