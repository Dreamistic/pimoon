import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeNativeFileSystem } from "../../../src/harness/filesystem/platform/node/native-filesystem.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
import { collectAsync, expectFsOk, openReadonly, overrideNativeFileSystem, type OpenedReadonly } from "./fixtures.ts";
import { createVisibilityPolicy } from "./policy-fixture.ts";

const temp = useTempDir("visibility-pruning-");
const exec = promisify(execFile);
async function write(file: string, text = "fixture") {
	await mkdir(path.dirname(path.join(temp.path, file)), { recursive: true });
	await writeFile(path.join(temp.path, file), text);
}
async function discover(opened: OpenedReadonly, scope = ".", maxEntries = 100) {
	const root = await opened.resolveDirectory(scope);
	return collectAsync(expectFsOk(await opened.services.discovery.discover(root, { maxEntries })));
}
async function visible(opened: OpenedReadonly, scope = ".") {
	return (await discover(opened, scope)).flatMap(event => event.type === "entry" && event.ref.kind === "file" ? [event.ref.displayPath] : []);
}

describe("搜索目录剪枝", () => {
	it("无关反向规则不使构建目录消耗搜索预算，显式 scope 仍可搜索", async () => {
		await write(".gitignore", ".tmp/\ndist/\n.env.*\n!.env.example\n.yarn/*\n!.yarn/patches\n");
		await write(".piignore", "!cache/keep.txt\n");
		for (let i = 0; i < 20; i++) await write(`.tmp/case-${i}/deep/noise.txt`);
		await write("dist/bundle.js");
		await write("src/main.ts");
		await write(".env.example");
		await write(".env.secret");
		await write(".yarn/patches/keep.patch");
		await write(".yarn/cache/drop.zip");
		const directories: string[] = [];
		const base = new NodeNativeFileSystem();
		const opened = await openReadonly(temp.path, { native: overrideNativeFileSystem({
			async readdir(file, context) { directories.push(path.relative(temp.path, file)); return base.readdir(file, context); },
		}, base) });
		const events = await discover(opened, ".", 15);
		expect(events.some(event => event.type === "skip" && event.reason === "entry-limit")).toBe(false);
		const files = events.flatMap(event => event.type === "entry" && event.ref.kind === "file" ? [event.ref.displayPath] : []);
		expect(files).toEqual(expect.arrayContaining(["src/main.ts", ".env.example", ".yarn/patches/keep.patch"]));
		expect(files).not.toContain(".env.secret");
		// 允许检查被忽略目录自身的高优先级 .piignore，但不递归其子树。
		expect(directories.filter(directory => directory === ".tmp")).toHaveLength(1);
		expect(directories.some(directory => directory.startsWith(`.tmp${path.sep}`))).toBe(false);
		expect(await visible(opened, "dist")).toContain("dist/bundle.js");
		expect(expectFsOk(await opened.readText(".tmp/case-0/deep/noise.txt")).text).toBe("fixture");
	});

	it("更高来源的后代例外仍可达，同来源必须先包含父目录", async () => {
		await write(".gitignore", "cache/\nlogs/\n");
		await write(".piignore", "!cache/keep.txt\nlogs/\n!logs/keep.txt\n");
		await write("cache/keep.txt"); await write("cache/drop.txt"); await write("logs/keep.txt");
		const opened = await openReadonly(temp.path);
		expect(await visible(opened)).toContain("cache/keep.txt");
		expect(await visible(opened)).not.toContain("cache/drop.txt");
		expect(await visible(opened)).not.toContain("logs/keep.txt");
	});

	it.each(["!cache/*.txt", "!**/keep.txt", "!keep.txt"])("高优先级通配例外 %s 不被静态前缀剪枝遗漏", async pattern => {
		await write(".gitignore", "cache/\n");
		await write(".piignore", `${pattern}\n`);
		await write("cache/keep.txt");
		expect(await visible(await openReadonly(temp.path))).toContain("cache/keep.txt");
	});

	it("Git 已跟踪后代阻止 gitignore 剪枝，但不绕过 piignore 或配置", async () => {
		await exec("git", ["init"], { cwd: temp.path, windowsHide: true });
		await write(".gitignore", "generated/\n!.env.example\n");
		await write("generated/deep/tracked.txt"); await write("generated/deep/noise.txt");
		await exec("git", ["add", "-f", "generated/deep/tracked.txt"], { cwd: temp.path, windowsHide: true });
		expect(await visible(await openReadonly(temp.path))).toContain("generated/deep/tracked.txt");
		expect(await visible(await openReadonly(temp.path))).not.toContain("generated/deep/noise.txt");
		const configured = await openReadonly(temp.path, { policy: createVisibilityPolicy({ ignoredPaths: ["generated/"] }) });
		expect(await visible(configured)).not.toContain("generated/deep/tracked.txt");
		await write(".piignore", "generated/\n!generated/deep/tracked.txt\n");
		expect(await visible(await openReadonly(temp.path))).not.toContain("generated/deep/tracked.txt");
	});

	it("嵌套规则只影响其子树，重新包含父目录后可继续发现", async () => {
		await write(".gitignore", "build/\n!build/\nbuild/*\n!build/keep/\n");
		await write("build/drop/file.txt"); await write("build/keep/file.txt");
		await write("src/.gitignore", "*.tmp\n!keep.tmp\n");
		await write("src/drop.tmp"); await write("src/keep.tmp"); await write("other/drop.tmp");
		const files = await visible(await openReadonly(temp.path));
		expect(files).toEqual(expect.arrayContaining(["build/keep/file.txt", "src/keep.tmp", "other/drop.tmp"]));
		expect(files).not.toContain("build/drop/file.txt");
		expect(files).not.toContain("src/drop.tmp");
	});
});
