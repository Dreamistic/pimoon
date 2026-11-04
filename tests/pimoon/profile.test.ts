import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each([
	{ name: "首次启动", original: undefined, expected: ["read", "write", "edit", "find", "grep", "ls", "process_run", "http", "websearch", "webfetch"] },
	{ name: "旧版文件列表移除废弃入口且不补进程权限", original: '// keep comment\n{"defaultTools":["read","write","edit","find","grep","ls","codemode"],"defaultModel":"custom",}', expected: ["read", "write", "edit", "find", "grep", "ls"] },
	{ name: "旧版进程权限迁移", original: '{"defaultTools":["read","bash","edit","write","grep","find","ls","codemode"],"codemode":{"mode":"only"}}', expected: ["read", "process_run", "edit", "write", "grep", "find", "ls"] },
	{ name: "迁移不重复已有进程函数", original: '{"defaultTools":["read","bash","process_run"]}', expected: ["read", "process_run"] },
	{ name: "增减配置保留启停意图", original: '{"defaultTools":["+bash","-bash","+codemode","-codemode","+read"]}', expected: ["+process_run", "-process_run", "+read"] },
	{ name: "自定义能力原样保留，不补执行入口", original: '{"defaultTools":["read"]}', expected: ["read"] },
	{ name: "只有读取权限不补进程权限", original: '{"defaultTools":["read","codemode"]}', expected: ["read"] },
	{ name: "只有废弃入口变为空权限列表", original: '{"defaultTools":["codemode"]}', expected: [] },
	{ name: "显式关闭工具", original: '{"defaultTools":[]}', expected: [] },
])("$name 的工具默认值", async ({ original, expected }) => {
	const base = path.resolve(".tmp/tests/pimoon-profile");
	await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const home = path.join(folder, "home");
	const agentDir = path.join(home, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const settings = path.join(agentDir, "settings.json");
	if (original !== undefined) await fs.writeFile(settings, original);
	const env = { ...process.env, PIMOON_HOME: home, PIMOON_WORKSPACE: path.join(home, "workspace"), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
	await execute(process.execPath, [path.resolve("src/pimoon/profile.ts")], { env, windowsHide: true });
	const text = await fs.readFile(settings, "utf8");
	const value: unknown = parse(text);
	expect(value).toHaveProperty("defaultTools", expected);
	expect(value).not.toHaveProperty("codemode");
	if (original?.includes("keep comment")) {
		expect(text).toContain("// keep comment");
		expect(value).toHaveProperty("defaultModel", "custom");
	}
	await execute(process.execPath, [path.resolve("src/pimoon/profile.ts")], { env, windowsHide: true });
	expect(await fs.readFile(settings, "utf8")).toBe(text);
});
