import { mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { MemoryStore } from "../../../src/harness/memory/store.ts";
import { INDEX_BYTES, memoryContext } from "../../../src/harness/memory/context.ts";
import { parseMemory } from "../../../src/harness/memory/format.ts";

const temp = useTempDir("pimoon-memory-");
let store: MemoryStore, cwd: string, project: string;
const entry = (name: string, body = "BODY_NOT_AUTO_LOADED", status = "active") => `---\nname: ${name}\ndescription: 遇到 ${name} 时读取\ntype: lesson\nstatus: ${status}\n---\n${body}\n`;
beforeEach(async () => {
	cwd = path.join(temp.path, "workspace"); await mkdir(cwd);
	store = new MemoryStore(path.join(temp.path, "memory"));
	project = (await store.scopes(cwd)).find(scope => scope.kind === "project")?.directory ?? "";
});

describe("自主记忆", () => {
	it("创建索引但不自动暴露正文；新实例沿用同一项目身份", async () => {
		const file = path.join(project, "entries/lesson.md");
		await writeFile(file, entry("恢复副作用"));
		const snapshot = await store.snapshot(cwd);
		const context = memoryContext(snapshot);
		expect(context).toContain("恢复副作用");
		expect(context).not.toContain("BODY_NOT_AUTO_LOADED");
		expect(await readFile(path.join(project, "MEMORY.md"), "utf8")).not.toContain("BODY_NOT_AUTO_LOADED");
		const next = new MemoryStore(store.root);
		expect(await next.scopes(cwd)).toEqual(await store.scopes(cwd));
		expect((await next.snapshot(cwd)).entries).toHaveLength(1);
	});
	it("空目录提供绝对路径和首次写入格式", async () => {
		const context = memoryContext(await store.snapshot(cwd));
		expect(context).toContain(project);
		expect(context).toContain("YAML name, description");
		expect(context).toContain("shown=0/0");
	});
	it("外部修改、归档、删除与格式损坏都替换旧摘要", async () => {
		const file = path.join(project, "entries/lesson.md");
		await writeFile(file, entry("旧摘要")); await store.snapshot(cwd);
		await writeFile(file, entry("新摘要"));
		expect(memoryContext(await store.snapshot(cwd))).not.toContain("旧摘要");
		await writeFile(file, entry("新摘要", "body", "archived"));
		expect(memoryContext(await store.snapshot(cwd))).not.toContain("新摘要");
		await writeFile(file, "broken");
		const broken = await store.snapshot(cwd);
		expect(broken.entries).toHaveLength(0); expect(broken.issues).toHaveLength(1);
		await rm(file);
		const removed = await store.snapshot(cwd);
		expect(removed.entries).toHaveLength(0); expect(removed.issues).toHaveLength(0);
	});
	it("超预算明确告知省略，完整索引仍包含所有活动条目", async () => {
		for (let i = 0; i < 120; i++) await writeFile(path.join(project, `entries/lesson-${i.toString().padStart(3, "0")}.md`), entry(`经验${i}`));
		const snapshot = await store.snapshot(cwd);
		const text = memoryContext(snapshot, true);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INDEX_BYTES);
		expect(text).toContain("/120"); expect(text).toContain("Omitted entries");
		expect(text).toContain("Previously read");
		expect(await readFile(path.join(project, "MEMORY.md"), "utf8")).toContain("经验119");
	});
	it("两个实例并发生成索引不丢条目，索引损坏可恢复", async () => {
		const second = new MemoryStore(store.root);
		await Promise.all([writeFile(path.join(project, "entries/a.md"), entry("经验A")), writeFile(path.join(project, "entries/b.md"), entry("经验B"))]);
		await Promise.all([store.snapshot(cwd), second.snapshot(cwd)]);
		await writeFile(path.join(project, "MEMORY.md"), "bad index");
		await second.snapshot(cwd);
		const index = await readFile(path.join(project, "MEMORY.md"), "utf8");
		expect(index).toContain("经验A"); expect(index).toContain("经验B");
	});
	it("不跟随 entries 目录 junction 或读取链接的正文", async () => {
		const outside = path.join(temp.path, "external"); await mkdir(outside);
		await writeFile(path.join(outside, "secret.md"), entry("不该加载"));
		await rm(path.join(project, "entries"), { recursive: true });
		await symlink(outside, path.join(project, "entries"), "junction");
		await expect(store.snapshot(cwd)).rejects.toThrow("not links");
	});
	it("独立项目隔离，同仓库 worktree 共用记忆", async () => {
		const repository = path.join(temp.path, "repo"), worktree = path.join(temp.path, "tree");
		await mkdir(repository);
		const git = (args: string[]) => execFileSync("git", ["-C", repository, ...args], { windowsHide: true, stdio: "pipe" });
		git(["init"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
		git(["worktree", "add", "-b", "fixture-tree", worktree]);
		const first = await store.scopes(repository), second = await store.scopes(worktree);
		expect(first).toEqual(second); expect(first.find(scope => scope.kind === "project")?.directory).not.toBe(project);
	});
	it("取消扫描不创建新的记忆目录或写入索引", async () => {
		const next = new MemoryStore(path.join(temp.path, "cancelled-memory"));
		const controller = new AbortController(); controller.abort();
		await expect(next.snapshot(cwd, controller.signal)).rejects.toThrow();
		await expect(readFile(path.join(next.root, "projects.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("拒绝过大、无正文或未知类型；归档不删除原文", () => {
		expect(() => parseMemory(entry("a", "x".repeat(32 * 1024)))).toThrow("32 KiB");
		expect(() => parseMemory(entry("a", ""))).toThrow("empty");
		expect(() => parseMemory(entry("a").replace("type: lesson", "type: authorization"))).toThrow("type");
		expect(parseMemory(entry("a", "body", "archived")).archived).toBe(true);
	});
});
