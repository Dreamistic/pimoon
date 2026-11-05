import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolsExtension } from "../../../src/harness/extensions/cmd-slash-tools.ts";
import processFunctions from "../../../src/harness/extensions/codeact-functions.ts";
import type { ToolSelectionController } from "../../../src/harness/tool-defaults/controller.ts";
import { startModelServer } from "../../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";
import { createRuntimeResources } from "../../pimoon/runtime-resources.ts";
import { migrateToolSettings } from "../../../src/pimoon/tool-settings.ts";

const temp = useTempDir("pimoon-functions-session-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let cwd: string, agentDir: string, runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>>;
beforeEach(async () => {
	setTestHome(temp.path); cwd = path.join(temp.path, "workspace"); agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true }); await mkdir(agentDir, { recursive: true });
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(temp.path));
	server = await startModelServer(() => ({ text: "done" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off", defaultTools: ["read", "process_run", "write"], compaction: { enabled: false }, retry: { enabled: false } }));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
});
afterEach(async () => { await runtime?.dispose(); runtime = undefined; await server.close(); vi.unstubAllEnvs(); });
async function start(manager = SessionManager.create(cwd), tools?: string[]) {
	let controller: ToolSelectionController | undefined;
	const { CodeAct } = await import("../../../src/pimoon/codeact/session.ts");
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const codeact = new CodeAct();
		const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [codeact.extension, { name: "process", factory: processFunctions }, { name: "tools", factory: createToolsExtension({ bindController: value => { controller = value; }, startup: tools === undefined ? {} : { tools } }) }] } });
		const result = await createAgentSessionFromServices({ services, sessionManager, ...(tools ? { tools: ["execute", ...tools] } : {}), ...(sessionStartEvent ? { sessionStartEvent } : {}) });
		codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager: manager });
	await runtime.session.bindExtensions({ mode: "print" });
	if (!controller) throw new Error("函数权限未绑定");
	return { session: runtime.session, controller };
}
const selected = (controller: ToolSelectionController) => controller.listTools().filter(fn => fn.enabled).map(fn => fn.name);
const requestText = () => JSON.stringify(server.requests.at(-1));
function expectNoNativeTools() { expect(server.requests.at(-1)?.tools?.map(tool => tool.function.name)).toEqual(["execute"]); }

describe("CodeAct 固定执行与函数权限", () => {
	it("升级旧版默认配置后新会话保留进程权限并生成真实函数目录", async () => {
		const file = path.join(agentDir, "settings.json");
		const settings: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"));
		await writeFile(file, migrateToolSettings(JSON.stringify({ ...settings, defaultTools: ["read", "bash", "write", "codemode"], codemode: { mode: "only" } })));
		const { session, controller } = await start();
		expect(selected(controller).sort()).toEqual(["process_run", "read", "write"]);
		await session.prompt("Use migrated functions");
		expectNoNativeTools(); expect(requestText()).toContain("process_run(argv:");
	});
	it("固定 execute 不参与函数开关，不改写用户默认函数", async () => {
		const { session, controller } = await start();
		expect(selected(controller).sort()).toEqual(["process_run", "read", "write"]);
		expect(controller.listTools().some(fn => fn.name === "bash" || fn.name === "powershell" || fn.name === "codemode")).toBe(false);
		expect(controller.hasUserDefaultChanges(["read", "process_run", "write"])).toBe(false);
		await session.prompt("CodeAct"); expectNoNativeTools(); expect(requestText()).toContain("process_run(");
		expect(JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")).defaultTools).toEqual(["read", "process_run", "write"]);
	});
	it("显式选择只开放指定函数，空列表仍保留 Python 环境", async () => {
		let host = await start(SessionManager.create(cwd), ["process_run"]);
		expect(selected(host.controller)).toEqual(["process_run"]);
		await host.session.prompt("Only processes"); expectNoNativeTools(); expect(requestText()).not.toContain("read(path:");
		await runtime?.dispose(); host = await start(SessionManager.create(cwd), []);
		expect(selected(host.controller)).toEqual([]);
		await host.session.prompt("No I/O"); expectNoNativeTools(); expect(requestText()).toContain("Functions:\\nNone.");
	});
	it("函数开关不切换执行模式，也不允许恢复 Shell 包装", async () => {
		const { session, controller } = await start();
		controller.set("read", false); controller.set("process_run", false); controller.set("write", false);
		controller.set("bash", true); controller.set("powershell", true);
		expect(selected(controller)).toEqual([]);
		await session.prompt("No I/O"); expectNoNativeTools();
		controller.set("read", true); await session.prompt("Read only");
		expectNoNativeTools(); expect(selected(controller)).toEqual(["read"]); expect(requestText()).toContain("read(path:");
	});
	it("保存默认函数并在新会话恢复", async () => {
		let host = await start(); host.controller.set("read", false); await host.controller.persistUserDefaults();
		await runtime?.dispose(); host = await start();
		expect(selected(host.controller)).not.toContain("read"); await host.session.prompt("Saved defaults"); expectNoNativeTools();
	});
	it("恢复及分支导航保持函数权限，不产生旧工具调用", async () => {
		let host = await start(); host.controller.set("process_run", false); await host.session.prompt("File functions");
		const leaf = host.session.sessionManager.getLeafId(), file = host.session.sessionFile;
		if (!leaf || !file) throw new Error("缺少会话分支");
		await runtime?.dispose(); host = await start(SessionManager.open(file));
		expect(selected(host.controller)).not.toContain("process_run");
		await host.session.prompt("Resume"); expectNoNativeTools();
		host.controller.set("read", false); await host.session.prompt("Other branch");
		await host.session.navigateTree(leaf, { summarize: false }); await host.session.prompt("Return"); expectNoNativeTools();
		expect(selected(host.controller)).toContain("read"); expect(selected(host.controller)).not.toContain("process_run");
	});
});
