import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { userAgentConfigPath, userAgentPath } from "../../src/harness/config-loader.ts";
import { telemetryRunsDirectory, userHistoryPath, resourceCacheDirectory } from "../../src/harness/storage/paths.ts";
import { agentHome, pimoonHome } from "../../src/pimoon/profile.ts";
import { checkReadablePath, checkWritablePath } from "../../src/pimoon/paths.ts";

it("配置、历史、遥测与缓存都使用 pimoon 根目录而不是 ~/.pi", () => {
	expect(userAgentConfigPath("gui.jsonc", "PIMOON_TEST_UNUSED_CONFIG")).toBe(path.join(agentHome, "configs/gui.jsonc"));
	expect(userAgentPath("mcp.jsonc", "PIMOON_TEST_UNUSED_CONFIG")).toBe(path.join(agentHome, "mcp.jsonc"));
	for (const target of [telemetryRunsDirectory(), userHistoryPath(), resourceCacheDirectory()]) expect(path.relative(pimoonHome, target)).not.toMatch(/^\.\./);
});

it("普通写入跨工作区和 junction，凭据与控制面仍受保护", async () => {
	const parent = path.resolve(".tmp/tests/pimoon-paths"); await fs.mkdir(parent, { recursive: true });
	const folder = await fs.mkdtemp(path.join(parent, "case-"));
	const cwd = path.join(folder, "workspace"), outside = path.join(folder, "outside");
	await fs.mkdir(cwd); await fs.mkdir(outside); await fs.symlink(outside, path.join(cwd, "escape"), "junction");
	await expect(checkWritablePath(cwd, "new/future.txt", [])).resolves.toBeUndefined();
	await expect(checkWritablePath(cwd, "../outside/new.txt", [])).resolves.toBeUndefined();
	await expect(checkWritablePath(cwd, "escape/future.txt", [])).resolves.toBeUndefined();
	await expect(checkWritablePath(cwd, "escape/future.txt", [outside])).rejects.toThrow("受保护");
	await expect(checkWritablePath(cwd, path.join(agentHome, "configs/approval-gate.jsonc"), [])).rejects.toThrow("受保护");
	await expect(checkReadablePath(cwd, "//untrusted-host/share/file", [])).rejects.toThrow("网络");
});
