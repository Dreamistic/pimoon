import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DesktopWorkspaceState } from "../../src/desktop/workspace-state.ts";
import { useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("pimoon-workspace-state-");

describe("桌面工作区恢复", () => {
	it("首次启动使用默认目录，切换后重建状态仍恢复最后一个工作区", async () => {
		const file = path.join(temp.path, "desktop", "workspace-state.json");
		const first = path.join(temp.path, "工作区 with spaces");
		const last = path.join(temp.path, "另一个工作区");
		await mkdir(first);
		await mkdir(last);
		const state = new DesktopWorkspaceState(file);
		expect(state.restore(temp.path)).toBe(temp.path);
		state.select(first);
		state.select(last);
		expect(new DesktopWorkspaceState(file).restore(temp.path)).toBe(last);
		expect(JSON.parse(await readFile(file, "utf8"))).toBe(last);
	});

	it("上次目录删除或变成文件后退回默认目录", async () => {
		const file = path.join(temp.path, "workspace-state.json");
		const workspace = path.join(temp.path, "removed");
		await mkdir(workspace);
		new DesktopWorkspaceState(file).select(workspace);
		await rm(workspace, { recursive: true });
		expect(new DesktopWorkspaceState(file).restore(temp.path)).toBe(temp.path);
		await writeFile(workspace, "not a directory");
		expect(new DesktopWorkspaceState(file).restore(temp.path)).toBe(temp.path);
	});

	it.each(["{broken", "null", "{}", '"relative"', '""'])("忽略损坏或无效记录 %s", async (content) => {
		const file = path.join(temp.path, "workspace-state.json");
		await writeFile(file, content);
		expect(new DesktopWorkspaceState(file).restore(temp.path)).toBe(temp.path);
	});

	it("保存失败不抛出，之后仍可重新保存", async () => {
		const parent = path.join(temp.path, "desktop");
		await writeFile(parent, "blocked");
		const file = path.join(parent, "workspace-state.json");
		const state = new DesktopWorkspaceState(file);
		const report = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => state.select(temp.path)).not.toThrow();
			expect(report).toHaveBeenCalledOnce();
			await rm(parent);
			state.select(temp.path);
			expect(new DesktopWorkspaceState(file).restore("fallback")).toBe(temp.path);
		} finally { report.mockRestore(); }
	});
});
