import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { startModelServer } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

it("桌面无界面子代理同样使用文本 CodeAct，不回落到原生工具", async () => {
	const base = path.resolve(".tmp/tests/codeact-headless"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-")), cwd = path.join(folder, "workspace"); await fs.mkdir(cwd);
	const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_OFFLINE: "1", PIMOON_RESOURCE_DIR: await createRuntimeResources(folder) };
	for (const name of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
		const directory = path.join(folder, name.toLowerCase()); await fs.mkdir(directory); Object.assign(env, { [name]: directory });
	}
	const agentDir = path.join(folder, "pimoon_home", "agent"); await fs.mkdir(agentDir);
	env.PI_CODING_AGENT_DIR = agentDir;
	const server = await startModelServer(request => JSON.stringify(request.messages).includes("<execute_result status=")
		? { text: "fixture complete" } : { text: '<execute>\nfrom pathlib import Path\nPath("result.txt").write_text("child-codeact",encoding="utf-8")\n42\n</execute>' });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", defaultTools: ["read", "write"], compaction: { enabled: false }, retry: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	const entry = path.join(folder, "entry.mjs");
	await fs.writeFile(entry, `import {runCodeActHeadless} from ${JSON.stringify(pathToFileURL(path.resolve("src/harness/runtime/codeact-headless.ts")).href)};process.exitCode=await runCodeActHeadless(process.argv.slice(2));`);
	try {
		const result = await promisify(execFile)(process.execPath, ["--experimental-transform-types", entry, "--mode", "json", "-p", "--no-session", "--tools", "read,write", "Complete the fixture"], { cwd, env, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
		expect(result.stdout).toContain("fixture complete");
		expect(await fs.readFile(path.join(cwd, "result.txt"), "utf8")).toBe("child-codeact");
		expect(server.requests.length).toBeGreaterThanOrEqual(2);
		for (const request of server.requests) expect(request.tools ?? []).toEqual([]);
		expect(result.stdout).not.toContain('"type":"toolcall_start"');
	} finally { await server.close(); }
}, 40_000);
