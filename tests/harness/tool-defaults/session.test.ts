import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime,
	SessionManager, type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolsExtension } from "../../../src/harness/extensions/cmd-slash-tools.ts";
import { codemodeSelection } from "../../../src/harness/codemode/loadout.ts";
import type { ToolSelectionController } from "../../../src/harness/tool-defaults/controller.ts";
import { startModelServer } from "../../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../helpers/lifecycle.ts";
import { createRuntimeResources } from "../../pimoon/runtime-resources.ts";

const temp = useTempDir("pimoon-tools-session-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let cwd: string;
let agentDir: string;
let runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>>;

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(temp.path));
	server = await startModelServer(() => ({ text: "done" }));
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off",
		defaultTools: ["read", "bash", "write"],
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
});

afterEach(async () => {
	await runtime?.dispose();
	runtime = undefined;
	await server.close();
	vi.unstubAllEnvs();
});

async function start(manager = SessionManager.create(cwd), tools?: string[]) {
	let controller: ToolSelectionController | undefined;
	const { default: codemode } = await import("../../../src/harness/extensions/codemode.ts");
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir,
			resourceLoaderOptions: {
				noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
				extensionFactories: [
					{ name: "codemode", builtin: true, factory: codemode },
					{ name: "tools", factory: createToolsExtension({ bindController: value => { controller = value; }, startup: tools === undefined ? {} : { tools } }) },
				],
			},
		});
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(tools ? { tools: codemodeSelection(tools) } : {}), ...(sessionStartEvent ? { sessionStartEvent } : {}) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: manager });
	await runtime.session.bindExtensions({ mode: "print" });
	if (!controller) throw new Error("工具选择未绑定");
	return { session: runtime.session, controller };
}

function selected(controller: ToolSelectionController): string[] {
	return controller.listTools().filter(tool => tool.enabled).map(tool => tool.name);
}

function requestedTools(): string[] {
	return server.requests.at(-1)?.tools?.map(tool => tool.function.name) ?? [];
}

describe("CodeAct 工具选择与 SDK 状态", () => {
	it("旧默认列表补齐入口，不改写默认配置或擅自添加能力", async () => {
		const { session, controller } = await start();
		expect(selected(controller)).toEqual(expect.arrayContaining(["read", "bash", "write", "codemode"]));
		expect(selected(controller)).toHaveLength(4);
		expect(controller.hasUserDefaultChanges(["read", "bash", "write"])).toBe(false);
		await session.prompt("测试 CodeAct");
		expect(requestedTools()).toEqual(["codemode"]);
		expect(JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")).defaultTools).toEqual(["read", "bash", "write"]);
	});

	it("显式工具选择只补入口，空列表保持无工具", async () => {
		let host = await start(SessionManager.create(cwd), ["bash"]);
		expect(selected(host.controller)).toEqual(expect.arrayContaining(["bash", "codemode"]));
		await host.session.prompt("只启用进程能力");
		expect(requestedTools()).toEqual(["codemode"]);
		const description = server.requests.at(-1)?.tools?.[0]?.function.description;
		expect(description).toContain("bash(");
		expect(description).not.toContain("read(path:");
		await runtime?.dispose();
		host = await start(SessionManager.create(cwd), []);
		expect(selected(host.controller)).toEqual([]);
		await host.session.prompt("无工具对话");
		expect(requestedTools()).toEqual([]);
	});

	it("关闭 CodeAct 同时关闭宿主能力，重新启用能力会恢复入口", async () => {
		const { session, controller } = await start();
		controller.set("codemode", false);
		expect(selected(controller)).toEqual([]);
		await session.prompt("关闭执行");
		expect(requestedTools()).toEqual([]);
		controller.set("read", true);
		expect(selected(controller)).toEqual(expect.arrayContaining(["read", "codemode"]));
		await session.prompt("只允许读取");
		expect(requestedTools()).toEqual(["codemode"]);
		const description = server.requests.at(-1)?.tools?.[0]?.function.description;
		expect(description).toContain("read(");
		expect(description).not.toContain("bash(");
	});

	it("目录随能力选择变化，保存默认后新会话仍只有脚本入口", async () => {
		let host = await start();
		host.controller.set("read", false);
		await host.controller.persistUserDefaults();
		await host.session.prompt("更新能力目录");
		expect(server.requests.at(-1)?.tools?.[0]?.function.description).not.toContain("read(path:");
		await runtime?.dispose();
		host = await start();
		expect(selected(host.controller)).not.toContain("read");
		expect(selected(host.controller)).toContain("codemode");
		await host.session.prompt("使用已保存默认值");
		expect(requestedTools()).toEqual(["codemode"]);
	});

	it("恢复会话及导航分支保留能力选择，不回落到直接调用", async () => {
		let host = await start();
		host.controller.set("bash", false);
		await host.session.prompt("文件能力分支");
		const leaf = host.session.sessionManager.getLeafId(), file = host.session.sessionFile;
		if (!leaf || !file) throw new Error("缺少会话分支");
		await runtime?.dispose();
		host = await start(SessionManager.open(file));
		expect(selected(host.controller)).not.toContain("bash");
		await host.session.prompt("恢复分支");
		expect(requestedTools()).toEqual(["codemode"]);
		host.controller.set("codemode", false);
		await host.session.prompt("关闭执行分支");
		expect(requestedTools()).toEqual([]);
		await host.session.navigateTree(leaf, { summarize: false });
		await host.session.prompt("回到文件能力分支");
		expect(requestedTools()).toEqual(["codemode"]);
		expect(selected(host.controller)).not.toContain("bash");
	});

	it("SDK 恢复旧的直接工具集合后，下一次请求也补齐脚本入口", async () => {
		const { session } = await start();
		session.setActiveToolsByName(["bash"]);
		await session.prompt("旧工具集合");
		expect(requestedTools()).toEqual(["codemode"]);
		expect(session.getActiveToolNames()).toEqual(["bash", "codemode"]);
	});
});
