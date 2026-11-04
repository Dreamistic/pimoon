import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MutationQueue } from "../filesystem/platform/node/mutation-queue.ts";
import { parseMemory } from "./format.ts";
import { atomicText, MemoryStore, regularFile } from "./store.ts";

const queue = new MutationQueue();

/** 用户显式调用的管理界面；不触发模型，也不向聊天注入正文。 */
export async function manageMemory(store: MemoryStore, ctx: Pick<ExtensionCommandContext, "cwd" | "signal"> & {
	ui: Pick<ExtensionCommandContext["ui"], "select" | "editor" | "confirm" | "notify">;
}): Promise<void> {
	try {
		const snapshot = await store.snapshot(ctx.cwd, ctx.signal);
		const items = snapshot.entries.map(entry => ({
			path: entry.path, label: `${entry.scope.kind}/${entry.file}${entry.archived ? " [已归档]" : ""}: ${entry.name}`,
		}));
		for (const issue of snapshot.issues) {
			if (path.basename(path.dirname(issue.file)) === "entries" && !items.some(item => item.path === issue.file))
				items.push({ path: issue.file, label: `[无效] ${issue.file}: ${issue.reason}` });
		}
		if (!items.length) {
			ctx.ui.notify(`记忆目录：\n${snapshot.scopes.map(scope => scope.directory).join("\n")}${snapshot.issues.length ? "\n" + snapshot.issues.map(issue => issue.reason).join("\n") : "\n尚无记忆，AI 会在工作中自主沉淀。"}`, "info");
			return;
		}
		const selection = await ctx.ui.select("自主记忆", items.map(item => item.label));
		const item = items.find(item => item.label === selection);
		if (!item) return;
		const action = await ctx.ui.select(item.label, ["查看 / 编辑", "归档", "恢复", "删除"]);
		if (!action) return;
		await regularFile(item.path);
		const original = await readFile(item.path, "utf8");
		let updated: string | undefined;
		if (action === "查看 / 编辑") {
			updated = await ctx.ui.editor(item.label, original);
			if (updated === undefined || updated === original) return;
			parseMemory(updated);
		} else if (action === "归档" || action === "恢复") {
			parseMemory(original);
			const status = `status: ${action === "归档" ? "archived" : "active"}`;
			const closing = original.indexOf("\n---", 4);
			const head = original.slice(0, closing), tail = original.slice(closing);
			updated = (/^status\s*:/m.test(head) ? head.replace(/^status\s*:.*$/m, status) : head + "\n" + status) + tail;
		} else if (!await ctx.ui.confirm("删除记忆", "删除此文件？已有聊天中的内容不会随之清除。")) return;
		await queue.run(item.path, ctx.signal, async () => {
			await regularFile(item.path);
			if (await readFile(item.path, "utf8") !== original) throw new Error("记忆已被其他会话修改，请重新打开。");
			if (action === "删除") await rm(item.path);
			else if (updated !== undefined) await atomicText(item.path, updated, ctx.signal);
		});
		await store.snapshot(ctx.cwd, ctx.signal);
		ctx.ui.notify(action === "删除" ? "记忆已删除。" : "记忆已保存。", "info");
	} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
}
