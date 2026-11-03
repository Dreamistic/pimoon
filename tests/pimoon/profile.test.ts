import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "jsonc-parser";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it.each([
	{ name: "首次启动", original: undefined, shell: true },
	{ name: "旧版默认列表保留注释及其他设置", original: '// keep comment\n{"defaultTools":["read","write","edit","find","grep","ls","codemode"],"defaultModel":"custom",}', shell: true },
	{ name: "自定义工具列表", original: '{"defaultTools":["read","codemode"]}', shell: false },
	{ name: "显式关闭工具", original: '{"defaultTools":[]}', shell: false },
])("$name 的工具默认值", async ({ original, shell }) => {
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
	expect(value).toHaveProperty("defaultTools");
	if (typeof value !== "object" || value === null || !("defaultTools" in value) || !Array.isArray(value.defaultTools)) throw new Error("工具配置无效");
	expect(value.defaultTools.includes("bash")).toBe(shell);
	expect(value.defaultTools.includes("websearch")).toBe(shell);
	expect(value.defaultTools.includes("webfetch")).toBe(shell);
	if (!shell) expect(text).toBe(original);
	if (original?.includes("keep comment")) {
		expect(text).toContain("// keep comment");
		expect(value).toHaveProperty("defaultModel", "custom");
	}
	await execute(process.execPath, [path.resolve("src/pimoon/profile.ts")], { env, windowsHide: true });
	expect(await fs.readFile(settings, "utf8")).toBe(text);
});
