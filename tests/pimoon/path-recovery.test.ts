import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkReadablePath } from "../../src/pimoon/paths.ts";
import { action, fixture } from "./native-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

it("缺失路径仍检查原路径、真实父目录和悬空链接", async () => {
	const base = path.resolve(".tmp/tests/path-recovery");
	await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const protectedDir = path.join(root, "protected");
	await fs.mkdir(protectedDir);
	await fs.symlink(protectedDir, path.join(root, "link"), "junction");
	await expect(checkReadablePath(root, "missing/deep.txt", [], true)).resolves.toBe(path.join(root, "missing/deep.txt"));
	await expect(checkReadablePath(root, "missing/deep.txt", [])).rejects.toThrow();
	for (const target of ["protected/missing.txt", "link/missing/deep.txt"])
		await expect(checkReadablePath(root, target, [protectedDir], true)).rejects.toThrow("受保护");
	await expect(checkReadablePath(root, "missing/secret.txt", [path.join(root, "missing")], true)).rejects.toThrow("受保护");
	await expect(checkReadablePath(root, "//untrusted/share/missing", [], true)).rejects.toThrow("网络");
	await fs.symlink(path.join(root, "absent-target"), path.join(root, "dangling"), "junction");
	await expect(checkReadablePath(root, "dangling/child.txt", [], true)).rejects.toThrow("链接");
});

it("真实 execute 的缺失读取能返回相近路径而非前置 ENOENT", async () => {
	const value = await fixture([action('read(path="setting.ts")'), { text: "done" }]);
	try {
		await fs.writeFile(path.join(value.cwd, "settings.ts"), "export const setting = 1;");
		await value.runtime.session.prompt("Fixture.");
		expect(value.results()[0]?.isError).toBe(true);
		expect(value.results()[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^error\n/) });
		const result = JSON.stringify(value.results()[0]?.content);
		expect(result).toContain("Related paths:");
		expect(result).toContain("settings.ts");
		expect(result).not.toContain("ENOENT");
	} finally { await value.close(); }
});

it.each(["find", "grep"])("%s 缺失搜索根不会阻断有效范围或扩大搜索", async name => {
	const code = `${name}(query="VISIBLE_MARKER", path=["missing", "valid"])`;
	const value = await fixture([action(code), { text: "done" }], undefined, [], undefined, ["execute", name]);
	try {
		await fs.mkdir(path.join(value.cwd, "valid"));
		await fs.writeFile(path.join(value.cwd, "valid/VISIBLE_MARKER.txt"), "VISIBLE_MARKER");
		await fs.writeFile(path.join(value.cwd, "VISIBLE_MARKER-outside.txt"), "VISIBLE_MARKER_OUTSIDE");
		await value.runtime.session.prompt("Fixture.");
		const result = JSON.stringify(value.results()[0]?.content);
		expect(result).toContain("valid/VISIBLE_MARKER.txt");
		expect(result).toContain("PATH_NOT_FOUND");
		expect(result).not.toContain("VISIBLE_MARKER-outside");
		expect(result).not.toContain("VISIBLE_MARKER_OUTSIDE");
	} finally { await value.close(); }
});

it.each(["find", "grep"])("%s 全部搜索根缺失时给出定位提示", async name => {
	const value = await fixture([action(`${name}(query="target", path=["missing"])`), { text: "done" }], undefined, [], undefined, ["execute", name]);
	try {
		await value.runtime.session.prompt("Fixture.");
		expect(value.results()[0]?.isError).toBe(true);
		expect(JSON.stringify(value.results()[0]?.content)).toContain("Locate the path with find or ls");
	} finally { await value.close(); }
});

it("raw 读取直接建立编辑版本，编辑保留 CRLF", async () => {
 const code = `source=read(path="config.py",mode="raw")
assert source=="value = 1\\r\\n"
edit(path="config.py", edits=[{"old":"value = 1", "new":"value = 2"}])`;
 const value = await fixture([action(code), { text: "done" }], undefined, [], undefined, ["execute", "read", "edit"]);
 try {
  await fs.writeFile(path.join(value.cwd, "config.py"), "value = 1\r\n");
  await value.runtime.session.prompt("Fixture.");
  expect(value.results()[0]?.isError).toBe(false);
  expect(await fs.readFile(path.join(value.cwd, "config.py"), "utf8")).toBe("value = 2\r\n");
  expect(JSON.stringify(value.server.requests[0]?.tools)).not.toContain("native_read");
 } finally { await value.close(); }
});
