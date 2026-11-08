import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { MemoryStore } from "../../../src/harness/memory/store.ts";
import { manageMemory } from "../../../src/harness/memory/manage.ts";
import { memoryContext } from "../../../src/harness/memory/context.ts";

const temp = useTempDir("pimoon-memory-manager-");
let store: MemoryStore, cwd: string, file: string;
const original = "---\nname: 管理测试\ndescription: 测试管理操作时读取\nmetadata:\n  type: reference\n---\n原始正文\n";
beforeEach(async () => {
	cwd = path.join(temp.path, "workspace"); await mkdir(cwd);
	store = new MemoryStore(path.join(temp.path, "memory"));
	const scope = (await store.scopes(cwd)).find(scope => scope.kind === "project");
	if (!scope) throw new Error("missing project");
	file = path.join(scope.directory, "entries/fixture.md"); await writeFile(file, original);
});
function ui(action: string) {
	let count = 0;
	return {
		select: async (_title: string, options: string[]) => count++ === 0 ? options[0] : action,
		editor: vi.fn(async (_title: string, content?: string) => content),
		confirm: vi.fn(async () => true),
		notify: vi.fn(),
	};
}
it("用户归档与恢复保留正文，自动索引及时更新", async () => {
	await manageMemory(store, { cwd, signal: undefined, ui: ui("归档") });
	expect(await readFile(file, "utf8")).toContain("原始正文");
	expect(memoryContext(await store.snapshot(cwd))).not.toContain("管理测试");
	await manageMemory(store, { cwd, signal: undefined, ui: ui("恢复") });
	expect(memoryContext(await store.snapshot(cwd))).toContain("管理测试");
});
it("编辑期间外部变化不被覆盖", async () => {
	const controls = ui("查看 / 编辑");
	controls.editor.mockImplementation(async () => { await writeFile(file, original + "external"); return original + "mine"; });
	await manageMemory(store, { cwd, signal: undefined, ui: controls });
	expect(await readFile(file, "utf8")).toBe(original + "external");
	expect(controls.notify).toHaveBeenCalledWith(expect.stringContaining("其他会话"), "error");
});
it("删除必须经显式确认，取消保留文件", async () => {
	const controls = ui("删除"); controls.confirm.mockResolvedValue(false);
	await manageMemory(store, { cwd, signal: undefined, ui: controls });
	await expect(access(file)).resolves.toBeUndefined();
	await manageMemory(store, { cwd, signal: undefined, ui: ui("删除") });
	await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await store.snapshot(cwd)).entries).toHaveLength(0);
});
