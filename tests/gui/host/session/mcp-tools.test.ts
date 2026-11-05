import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GuiHost } from "../../../../src/gui/host/host.ts";
import type { GuiClient } from "../../../../src/gui/host/client.ts";
import { preserveEnv, setTestHome, useTempDir } from "../../../helpers/lifecycle.ts";
import { startModelServer, type ModelResponse } from "../../../cli/model-server.ts";
import { createRuntimeResources } from "../../../pimoon/runtime-resources.ts";
import { readSnapshot } from "../read-snapshot.ts";
import { writeMcpFixture } from "../../helpers/mcp-fixture.ts";


const temp = useTempDir("pimoon-gui-mcp-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let host: GuiClient, model: Awaited<ReturnType<typeof startModelServer>>, response: ModelResponse;
let agentDir: string, mcpFile: string, fixture: string;
const probe = "mcp__fixture__probe", refresh = "mcp__fixture__refresh";
const prompt = (text: string) => ({ action: "prompt", text, images: [], behavior: "followUp" });
const execute = (code: string): ModelResponse => ({ tool: "execute", args: { code, desc: "MCP 验证" } });
const tool = () => readSnapshot(host).tools.find(tool => tool.name === probe);
const resultText = (allowError = false) => {
	const result = readSnapshot(host).messages.findLast(message => message.role === "toolResult" && message.toolName === "execute");
	if (!allowError) expect(result?.role === "toolResult" && result, JSON.stringify(result ?? model.requests.at(-1))).toMatchObject({ isError: false });
	return JSON.stringify(result?.role === "toolResult" && result.output?.kind === "inline" ? result.output.value.content : result ?? model.requests.at(-1));
};
const onlyExecute = () => { for (const request of model.requests.filter(request => Array.isArray(request.messages))) expect(request.tools?.map(tool => tool.function.name), JSON.stringify(request)).toEqual(["execute"]); };

beforeEach(async () => {
	setTestHome(temp.path); agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = "1";
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(temp.path));
	await mkdir(path.join(agentDir, "configs"), { recursive: true });
	await writeFile(path.join(agentDir, "configs", "auto-title.jsonc"), '{"enabled":false}');
	await writeFile(path.join(agentDir, "configs", "discord-presence.jsonc"), '{"enabled":false}');
	response = { text: "done" };
	model = await startModelServer(request => request.messages.at(-1)?.role === "tool" ? { text: "done" } : response);
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: model.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	fixture = await writeMcpFixture(temp.path); mcpFile = path.join(agentDir, "mcp.json"); host = new GuiHost().createClient();
});
afterEach(async () => { await host?.host.dispose(); await model?.close(); vi.unstubAllEnvs(); });
async function start(exposure: string, servers = ["fixture"]) {
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test", defaultTools: ["read"], compaction: { enabled: false }, retry: { enabled: false } }));
	await writeFile(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(servers.map(name => [name, { command: process.execPath, args: [fixture], exposure }])) }));
	await host.host.start(temp.path);
	await expect.poll(() => readSnapshot(host).tools.find(tool => tool.mcp)).toMatchObject({ enabled: true, callable: true });
	expect(host.runtime.session.getAllTools().some(tool => tool.name === "codemode")).toBe(false);
}

it("内置预设只调整函数权限，模型生成请求只声明 execute，不改写默认配置", async () => {
	const settings = path.join(agentDir, "settings.json");
	await writeFile(settings, JSON.stringify({ defaultProjectTrust: "never", defaultProvider: "fixture", defaultModel: "test", defaultTools: ["read"], extensions: ["-builtin:mcp"], compaction: { enabled: false }, retry: { enabled: false } }));
	await host.host.start(temp.path); const original = await readFile(settings, "utf8");
	const offline = ["edit", "find", "grep", "ls", "process_run", "read", "skill", "subagent", "write"];
	for (const [preset, expected] of [["vanilla", [...offline, "http", "websearch", "webfetch"]], ["web-chat", ["http", "websearch", "webfetch"]], ["offline", offline], ["no-tools", []]] as const) {
		await host.dispatch({ action: "toolPreset", preset }); const snapshot = readSnapshot(host);
		expect(snapshot.toolPreset).toBe(preset);
		expect(snapshot.tools.filter(tool => tool.enabled).map(tool => tool.name).sort()).toEqual([...expected].sort());
		expect(snapshot.tools.some(tool => ["codemode", "bash", "powershell"].includes(tool.name))).toBe(false);
		await host.dispatch(prompt(`使用 ${preset} 预设`)); onlyExecute();
	}
	expect(await readFile(settings, "utf8")).toBe(original);
});
it.each(["deferred", "direct"])("%s MCP 函数不参与内置预设匹配，预设不能清除服务选择", async exposure => {
	await start(exposure); await host.dispatch({ action: "tool", name: probe, enabled: false });
	const choices = () => readSnapshot(host).tools.filter(tool => tool.mcp).map(({ name, enabled, available }) => ({ name, enabled, available }));
	const original = choices();
	for (const preset of ["vanilla", "web-chat", "offline", "no-tools"] as const) {
		await host.dispatch({ action: "toolPreset", preset }); expect(readSnapshot(host).toolPreset).toBe(preset); expect(choices()).toEqual(original);
	}
	expect(tool()).toMatchObject({ enabled: false, callable: false });
	response = execute(`${refresh}()`); await host.dispatch(prompt("MCP 仍可由 Python 调用"));
	expect(resultText()).toContain("MCP_RESULT_refresh"); onlyExecute();
});
it.each(["deferred", "direct", "codemode"])("%s 服务总开关隔离调用，恢复保留单函数选择及排列", async exposure => {
	await start(exposure, ["fixture", "other"]); const original = await readFile(mcpFile, "utf8");
	await expect.poll(() => readSnapshot(host).tools.filter(tool => tool.mcpServer)).toHaveLength(4);
	const order = () => readSnapshot(host).tools.map(tool => tool.name), initial = order();
	await host.dispatch({ action: "tool", name: probe, enabled: false });
	await host.dispatch({ action: "mcpServers", names: ["fixture", "other"], enabled: false });
	expect(readSnapshot(host).tools.filter(tool => tool.mcpServer).every(tool => !tool.enabled && !tool.callable && !tool.available)).toBe(true);
	expect(order()).toEqual(initial);
	response = execute(`getattr(functions,"${refresh}")()`); await host.dispatch(prompt("关闭服务不能绕过"));
	expect(resultText(true)).not.toContain("MCP_RESULT_refresh"); expect(resultText(true)).toContain("AttributeError");
	await host.dispatch({ action: "mcpServers", names: ["fixture", "other"], enabled: true });
	expect(tool()).toMatchObject({ available: true, enabled: false }); expect(order()).toEqual(initial);
	response = execute(`${refresh}()`); await host.dispatch(prompt("恢复服务"));
	expect(resultText()).toContain("MCP_RESULT_refresh"); expect(await readFile(mcpFile, "utf8")).toBe(original); onlyExecute();
});
const resources = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
it("共享资源独立于服务工具开关；资源关闭、重载和恢复保持函数权限", async () => {
	await writeMcpFixture(temp.path, { resources: true }); await start("codemode");
	await expect.poll(() => readSnapshot(host).tools.filter(tool => resources.includes(tool.name))).toHaveLength(3);
	await host.dispatch({ action: "mcpServers", names: ["fixture"], enabled: false });
	response = execute('list_mcp_resources()\nread_mcp_resource(server="fixture",uri="fixture://document")'); await host.dispatch(prompt("读取共享资源"));
	expect(resultText()).toContain("RESOURCE_RESULT"); expect(resultText()).toContain("fixture://document");
	const order = readSnapshot(host).tools.map(tool => tool.name);
	for (const name of resources) await host.dispatch({ action: "tool", name, enabled: false });
	expect(readSnapshot(host).tools.map(tool => tool.name)).toEqual(order);
	response = execute('getattr(functions,"read_mcp_resource")(server="fixture",uri="fixture://document")'); await host.dispatch(prompt("关闭资源不可调用"));
	expect(resultText(true)).not.toContain("RESOURCE_RESULT"); expect(resultText(true)).toContain("AttributeError");
	await host.dispatch({ action: "reload" });
	await expect.poll(() => readSnapshot(host).tools.filter(tool => resources.includes(tool.name))).toHaveLength(3);
	expect(readSnapshot(host).tools.filter(tool => resources.includes(tool.name)).every(tool => !tool.enabled && !tool.callable)).toBe(true);
	await host.dispatch({ action: "tool", name: "read_mcp_resource", enabled: true });
	response = execute('read_mcp_resource(server="fixture",uri="fixture://document")'); await host.dispatch(prompt("只恢复读取"));
	expect(resultText()).toContain("RESOURCE_RESULT");
	expect(readSnapshot(host).tools.find(tool => tool.name === "list_mcp_resources")).toMatchObject({ enabled: false }); onlyExecute();
});
it("仅提供资源的服务也可通过 CodeAct 读取", async () => {
	await writeMcpFixture(temp.path, { resourceOnly: true }); await start("codemode");
	expect(readSnapshot(host).tools.some(tool => tool.mcpServer)).toBe(false);
	response = execute('read_mcp_resource(server="fixture",uri="fixture://document")'); await host.dispatch(prompt("资源服务"));
	expect(resultText()).toContain("RESOURCE_RESULT"); onlyExecute();
});
it.each(["codemode", "codemode-deferred", "deferred", "direct"])("SDK exposure=%s 的能力关闭后不可发现调用，开启后仅作为函数使用", async exposure => {
	await start(exposure); const original = await readFile(mcpFile, "utf8");
	await host.dispatch({ action: "tool", name: probe, enabled: false }); await host.dispatch({ action: "tool", name: refresh, enabled: false });
	expect(tool()).toMatchObject({ enabled: false, callable: false });
	expect(host.runtime.session.getAllTools().find(tool => tool.name === probe)?.exposure).toBe("hidden");
	response = execute(`getattr(functions,"${probe}")()`); await host.dispatch(prompt("隐藏函数不可调用"));
	expect(resultText(true)).toContain("AttributeError"); expect(resultText(true)).not.toContain("MCP_RESULT_probe");
	await host.dispatch({ action: "tool", name: probe, enabled: true });
	expect(tool()).toMatchObject({ enabled: true, callable: true });
	response = execute(`${probe}()`); await host.dispatch(prompt("恢复函数"));
	expect(resultText()).toContain("MCP_RESULT_probe"); expect(await readFile(mcpFile, "utf8")).toBe(original); onlyExecute();
});
it("刷新新增函数、重载和分支导航保留选择，新会话独立", async () => {
	await start("codemode"); await host.dispatch(prompt("建立会话"));
	const firstId = readSnapshot(host).sessionId, originalLeaf = host.runtime.session.sessionManager.getLeafId(), description = tool()?.description;
	await host.dispatch({ action: "tool", name: probe, enabled: false });
	response = execute(`${refresh}()`); await host.dispatch(prompt("刷新工具列表"));
	await expect.poll(() => tool()?.description).not.toBe(description); expect(tool()).toMatchObject({ enabled: false, callable: false });
	await expect.poll(() => readSnapshot(host).tools.find(tool => tool.name === "mcp__fixture__extra")).toMatchObject({ enabled: true, callable: true });
	response = execute("mcp__fixture__extra()"); await host.dispatch(prompt("下一块可直接调用新增函数")); expect(resultText()).toContain("MCP_RESULT_extra");
	await host.dispatch({ action: "mcpServers", names: ["fixture"], enabled: false });
	const disabledLeaf = host.runtime.session.sessionManager.getLeafId(); if (!originalLeaf || !disabledLeaf) throw new Error("缺少分支节点");
	await host.dispatch({ action: "reload" }); await expect.poll(tool).toMatchObject({ available: false, enabled: false, callable: false });
	await host.dispatch({ action: "navigate", entryId: originalLeaf, summarize: false }); await expect.poll(tool).toMatchObject({ enabled: true, callable: true });
	await host.dispatch({ action: "navigate", entryId: disabledLeaf, summarize: false }); await expect.poll(tool).toMatchObject({ available: false, enabled: false, callable: false });
	await host.dispatch({ action: "new" }); await expect.poll(tool).toMatchObject({ enabled: true, callable: true });
	await host.dispatch({ action: "openSession", id: firstId }); await expect.poll(tool).toMatchObject({ available: false, enabled: false, callable: false });
	const file = readSnapshot(host).sessionFile; if (!file) throw new Error("缺少会话文件");
	await host.host.dispose(); host = new GuiHost().createClient(); await host.host.start(temp.path); await host.dispatch({ action: "openSession", path: file });
	await expect.poll(tool).toMatchObject({ available: false, enabled: false, callable: false });
	await host.dispatch({ action: "mcpServers", names: ["fixture"], enabled: true }); expect(tool()).toMatchObject({ available: true, enabled: false, callable: false });
	const original = await readFile(mcpFile, "utf8");
	await host.dispatch({ action: "saveMcpConfig", original, content: JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], enabled: false } } }) });
	await host.dispatch({ action: "reload" }); expect(tool()).toBeUndefined();
});
it.each(["codemode", "deferred"])("%s MCP 能力支持函数内按需发现，没有模式切换或原生声明", async exposure => {
	await start(exposure); expect(host.runtime.session.getActiveToolNames()).toContain("tool_search");
	response = execute('tool_search(query="MCP_VISIBILITY_probe",limit=1)'); await host.dispatch(prompt("按需发现函数"));
	expect(resultText()).toContain(probe); onlyExecute();
	response = execute(`${probe}()`); await host.dispatch(prompt("调用发现的函数")); expect(resultText()).toContain("MCP_RESULT_probe");
	 expect(readSnapshot(host).tools.some(tool => tool.name === "codemode")).toBe(false);
});

it("原生入口不会出现在可关闭的函数列表", async () => {
    await start("direct");
    expect(readSnapshot(host).tools.some(tool => tool.name === "execute")).toBe(false);
    await host.dispatch({ action: "toolPreset", preset: "no-tools" });
    response = execute("42");
    await host.dispatch(prompt("仅 Python"));
    expect(resultText()).toContain("42");
    onlyExecute();
});
