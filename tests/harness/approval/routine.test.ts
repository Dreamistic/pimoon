import { mkdir, writeFile, symlink, link, readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { grantRoutineInspection, routineInspectionFilter } from "../../../src/harness/approval/routine-file-grant.ts";
import { routineOperation } from "../../../src/harness/approval/routine.ts";
import { grantRoutineProcess, routineProcessArgv } from "../../../src/harness/approval/routine-process-grant.ts";
import { pimoonHome } from "../../../src/pimoon/profile.ts";
import type { ApprovalRequest } from "../../../src/harness/approval/types.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
const temp = useTempDir("routine-");
const read = (file: string, name = "read"): ApprovalRequest => ({ tool: "other", cwd: temp.path, units: [], detail: { name, input: { path: file } } });
const edit = (file: string): ApprovalRequest => ({ tool: "edit", cwd: temp.path, units: [], detail: { path: path.resolve(temp.path, file), edits: [{ old: "before", new: "after" }] } });
const process = (argv: string[], env: Record<string, string> = {}, inherit_env?: false): ApprovalRequest => ({ tool: "process_run", cwd: temp.path, units: [], detail: { argv, env, ...(inherit_env === false ? { inherit_env } : {}) } });

it("普通读取搜索及源码编辑直接归类，包括新文件和不存在的普通目标", async () => {
	await mkdir(path.join(temp.path, "src")); await writeFile(path.join(temp.path, "src", "sample.ts"), "before");
	for (const name of ["read", "ls", "grep", "find"]) expect(await routineOperation(read("src/sample.ts", name), temp.path)).toBe("local_inspection");
	expect(await routineOperation(edit("src/sample.ts"), temp.path)).toBeUndefined();
	expect(await routineOperation(edit("src/sample.ts"), temp.path, new Set([path.join(temp.path, "src/sample.ts")]))).toBe("project_edit");
	expect(await routineOperation(edit("src/new.ts"), temp.path)).toBe("project_new_file");
	expect(await routineOperation(read("missing.txt"), temp.path)).toBe("local_inspection");
});
it.each(["../outside.txt", ".private/data.json", ".env", ".env.staging", ".git/config", "secrets.json", "certificate.pem"])("敏感或越界读取 %s 仍交给 AI", async file => {
	expect(await routineOperation(read(file), temp.path)).toBeUndefined();
});
it.each(["package.json", "package-lock.json", "vitest.config.ts", "tsconfig.json", "AGENTS.md", ".github/workflows/build.yml", "node_modules/lib.ts", "src/security/check.ts", "src/approval/check.ts", "run.ps1", "archive.bin"])("控制面、依赖或非普通文本写入 %s 不免审", async file => {
	expect(await routineOperation(edit(file), temp.path)).toBeUndefined();
});
it("多根搜索任一越界就不免审，不因默认工作区混入外部目标", async () => {
	const request: ApprovalRequest = { tool: "other", cwd: temp.path, units: [], detail: { name: "grep", input: { path: [".", "../"] } } };
	expect(await routineOperation(request, temp.path)).toBeUndefined();
});
it("链接到工作区外、悬空链接和硬链接不进入直接执行范围", async () => {
	const inside = path.join(temp.path, "workspace"), outside = path.join(temp.path, "outside");
	await mkdir(inside); await mkdir(outside); await writeFile(path.join(outside, "private.txt"), "private");
	await symlink(outside, path.join(inside, "escape"), "junction");
	await symlink(path.join(temp.path, "missing"), path.join(inside, "dangling"), "junction");
	await link(path.join(outside, "private.txt"), path.join(inside, "hard.txt"));
	for (const target of ["escape/private.txt", "escape/new.txt", "dangling/new.txt", "hard.txt"]) {
		const request = read(path.join(inside, target));
		expect(await routineOperation(request, inside)).toBeUndefined();
	}
});
it("受管 user 记忆正文可读写，生成元数据与其他项目记忆不自动放行", async () => {
	const scope = path.join(pimoonHome, "memory", "user"); await mkdir(path.join(scope, "entries"), { recursive: true });
	const file = path.join(scope, "entries", "fixture.md");
	expect(await routineOperation(read(file), temp.path)).toBe("local_inspection");
	expect(await routineOperation(edit(file), temp.path)).toBe("memory_entry");
	expect(await routineOperation(edit(path.join(scope, "MEMORY.md")), temp.path)).toBeUndefined();
	expect(await routineOperation(read(path.join(pimoonHome, "memory", "projects", "unrelated", "entries", "x.md")), temp.path)).toBeUndefined();
});
it.each([
	["status", "--short"], ["status", "--porcelain=v1"], ["diff", "--stat"], ["diff", "--cached", "--check"],
	["log", "-5", "--oneline"], ["show", "--stat", "HEAD"], ["rev-parse", "--short", "HEAD"], ["ls-files", "--cached"],
])("常规 Git 查询 %j 可直接执行", async (...args) => {
	expect(await routineOperation(process(["git", ...args]), temp.path)).toBe("git_inspection");
});
it.each([
	["push", "origin", "main"], ["reset", "--hard"], ["commit", "-m", "x"], ["-c", "alias.query=!bad", "query"],
	["-C", "../outside", "status"], ["diff", "--output=outside"], ["diff", "--ext-diff"], ["show", "HEAD:.env"],
	["diff", "--", ".env"], ["diff", "--", "../outside"], ["log", "--format=%(exec)"], ["diff", "--no-index", "a", "b"],
])("不明或危险 Git 参数 %j 仍交给 AI", async (...args) => {
	expect(await routineOperation(process(["git", ...args]), temp.path)).toBeUndefined();
});
it("Shell 包装、环境覆盖和伪装的 git 路径不整体免审", async () => {
	for (const request of [process(["powershell", "-Command", "git status; bad"]), process(["git", "status"], { GIT_EXTERNAL_DIFF: "bad" }), process([path.join(temp.path, "git.exe"), "status"])])
		expect(await routineOperation(request, temp.path)).toBeUndefined();
});
it("实际 Git 执行禁用 pager、fsmonitor、external diff 和 textconv；保护单次消费", async () => {
	execFileSync("git", ["init", temp.path], { windowsHide: true, stdio: "pipe" });
	await writeFile(path.join(temp.path, "sample.txt"), "before");
	execFileSync("git", ["-C", temp.path, "add", "sample.txt"], { windowsHide: true, stdio: "pipe" });
	await writeFile(path.join(temp.path, "sample.txt"), "after");
	const marker = path.join(temp.path, "bad-marker").replaceAll("\\", "/");
	const hook = `!echo injected > '${marker}'`;
	for (const setting of ["diff.external", "core.fsmonitor"]) execFileSync("git", ["-C", temp.path, "config", setting, hook], { windowsHide: true, stdio: "pipe" });
	const input = { argv: ["git", "diff"], cwd: temp.path };
	await grantRoutineProcess(input, temp.path, "git_inspection");
	const guarded = routineProcessArgv(input, input.argv);
	expect(guarded).toContain("--no-ext-diff"); expect(guarded).toContain("--no-textconv"); expect(guarded).toContain("core.fsmonitor=false");
	const [program, ...args] = guarded; if (!program) throw new Error("missing program");
	const out = execFileSync(program, args, { cwd: temp.path, windowsHide: true, encoding: "utf8" });
	expect(out).toContain("after"); await expect(readFile(marker)).rejects.toThrow();
	expect(routineProcessArgv(input, input.argv)).toEqual(input.argv);
	await grantRoutineProcess(input, temp.path, "git_inspection"); input.argv = ["git", "push"];
	expect(() => routineProcessArgv(input, input.argv)).toThrow("changed");
});

async function cli(tool: string, entry: string) {
	await mkdir(path.dirname(path.join(temp.path, "node_modules", tool, entry)), { recursive: true });
	await writeFile(path.join(temp.path, "node_modules", tool, "package.json"), JSON.stringify({ name: tool }));
	await writeFile(path.join(temp.path, "node_modules", tool, entry), "// fixture, not executed");
	return `node_modules/${tool}/${entry}`;
}
function isolatedEnv(): Record<string, string> {
	return Object.fromEntries(["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map(key => [key, path.join(temp.path, ".tmp", "tests", key)]));
}
it("仅直接 tsc --noEmit 免审，Node 注入、任意脚本和配置切换不免审", async () => {
	const entry = await cli("typescript", "bin/tsc");
	expect(await routineOperation(process(["node", entry, "--noEmit"]), temp.path)).toBe("local_typecheck");
	for (const argv of [["node", entry], ["node", entry, "--build"], ["node", entry, "--noEmit", "--project", "other"], ["node", "--require", "evil.js", entry, "--noEmit"], ["npm", "run", "typecheck"], ["node", "test.js"]])
		expect(await routineOperation(process(argv), temp.path)).toBeUndefined();
});
it("单测和构建必须使用直接 CLI、替换继承环境且所有 homes 在独立测试目录", async () => {
	const vitest = await cli("vitest", "vitest.mjs"), vite = await cli("vite", "bin/vite.js");
	const env = isolatedEnv();
	expect(await routineOperation(process(["node", vitest, "run", "tests/a.test.ts"], env, false), temp.path)).toBe("isolated_tests");
	expect(await routineOperation(process(["node", vite, "build"], env, false), temp.path)).toBe("isolated_build");
	for (const request of [process(["node", vitest, "run"]), process(["node", vitest, "run"], env),
		process(["node", vitest, "run"], { ...env, HOME: temp.path }, false),
		process(["node", vitest, "run"], { ...env, NODE_OPTIONS: "--require evil" }, false),
		process(["node", vitest, "run", "--config", "other.ts"], env, false), process(["node", vitest, "--ui"], env, false),
		process(["node", vite, "build", "--outDir", "../outside"], env, false), process(["node", vite, "preview"], env, false),
		process(["node", vitest, "run", "../outside.test.ts"], env, false)])
		expect(await routineOperation(request, temp.path)).toBeUndefined();
});

it("既有已跟踪文件可编辑；已有未跟踪文件的整文件覆盖仍交 AI", async () => {
	execFileSync("git", ["init", temp.path], { windowsHide: true, stdio: "pipe" });
	await writeFile(path.join(temp.path, "tracked.ts"), "before"); await writeFile(path.join(temp.path, "draft.txt"), "valuable");
	execFileSync("git", ["-C", temp.path, "add", "tracked.ts"], { windowsHide: true, stdio: "pipe" });
	expect(await routineOperation(edit("tracked.ts"), temp.path)).toBe("project_edit");
	const request: ApprovalRequest = { tool: "write", cwd: temp.path, units: [], detail: { path: path.join(temp.path, "draft.txt"), content: "replacement" } };
	expect(await routineOperation(request, temp.path)).toBeUndefined();
});

it("类型检查保护固定 Node 程序并禁用配置中的增量输出", async () => {
	const input = { argv: ["node", "node_modules/typescript/bin/tsc", "--noEmit"] };
	await grantRoutineProcess(input, temp.path, "local_typecheck");
	const argv = routineProcessArgv(input, input.argv);
	expect(path.isAbsolute(argv[0] ?? "")).toBe(true);
	expect(argv.slice(-4)).toEqual(["--incremental", "false", "--composite", "false"]);
});

it("有自定义 Vite 配置或 dist 链接越界时交给 AI，不靠 build 名称放行", async () => {
	const entry = await cli("vite", "bin/vite.js"), env = isolatedEnv();
	await writeFile(path.join(temp.path, "vite.config.ts"), "export default { build: { outDir: '../outside' } }");
	expect(await routineOperation(process(["node", entry, "build"], env, false), temp.path)).toBeUndefined();
});

it("根目录搜索过滤只属于当前输入，显式 AI 路径不继承旧过滤", async () => {
	const input = { path: [temp.path], query: "fixture" };
	await grantRoutineInspection(input, temp.path);
	const filter = routineInspectionFilter(input); if (!filter) throw new Error("missing filter");
	expect(filter(path.join(temp.path, "src", "ordinary.ts"))).toBe(false);
	expect(filter(path.join(temp.path, ".private", "data.txt"))).toBe(true);
	expect(filter(path.join(temp.path, ".env.staging"))).toBe(true);
	expect(filter(path.resolve(temp.path, "../outside.txt"))).toBe(true);
	expect(routineInspectionFilter(input)).toBeUndefined();
	await grantRoutineInspection(input, temp.path); input.path = ["../outside"];
	expect(() => routineInspectionFilter(input)).toThrow("changed");
});
