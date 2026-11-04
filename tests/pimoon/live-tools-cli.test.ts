import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { beforeAll, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/bench-live-tools.mjs", import.meta.url));
const env = { ...process.env };
beforeAll(() => {
	const base = path.resolve(".tmp/tests/live-tools-cli");
	fs.mkdirSync(base, { recursive: true });
	const home = fs.mkdtempSync(path.join(base, "case-"));
	for (const key of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
		env[key] = path.join(home, key.toLowerCase()); fs.mkdirSync(env[key]);
	}
});
function run(args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
}
it("帮助不需要订阅授权或读取凭据", () => {
	const result = run(["--help"]);
	expect(result.status).toBe(0);
	expect(result.stdout).toContain("--thinking=low");
	expect(result.stdout).toContain("--transport=sse|auto");
	expect(result.stdout).toContain("--prompt=runtime|sdk");
});
it("没有显式 live 时阻止订阅测试", () => {
	const result = run(["--apps=pimoon"]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("需显式 --live");
});
it.each([
	["--thinking=invalid", "无效 thinking"],
	["--transport=invalid", "transport 必须"],
	["--prompt=invalid", "prompt 必须"],
	["--apps=invalid", "apps 必须"],
	["--apps=pimoon,pimoon", "apps 必须"],
	["--runs=0", "runs 必须"],
	["--scenarios=invalid", "未知场景"],
])("无效选项在读取凭据前拒绝：%s", (option, error) => {
	const result = run(["--live", ...(option.startsWith("--apps=") ? [] : ["--apps=pimoon"]), option]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain(error);
	expect(result.stderr).not.toContain("auth.json");
});
it("单测 pimoon 不需要上游路径，但必须有独立有效凭据", () => {
	const result = run(["--live", "--apps=pimoon"]);
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("ENOENT");
	expect(result.stderr).toContain("auth.json");
	expect(result.stderr).not.toContain("请指定 --upstream");
});
