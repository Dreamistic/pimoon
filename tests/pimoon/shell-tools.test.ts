import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import bashTool from "../../src/harness/extensions/bash-tool.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import webTools from "../../src/harness/extensions/web-tools.ts";
import { codemodeHiddenDeclarations } from "../../src/harness/codemode/loadout.ts";
import * as webConfig from "../../src/harness/web-tools/config.ts";
import type { WebHttpFetch } from "../../src/harness/web-tools/network/types.ts";
import { startModelServer } from "../cli/model-server.ts";
import { defaultWebToolsConfig } from "../harness/web-tools/config-fixture.ts";
import { httpResponse } from "../helpers/http.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

const network = vi.hoisted(() => ({ fetch: vi.fn<WebHttpFetch>() }));
vi.mock("undici/index.js", async (importOriginal) => ({
	...await importOriginal<typeof import("undici")>(),
	fetch: network.fetch,
}));

const execute = promisify(execFile);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("Git、搜索和网页只通过 CodeAct 执行，直调被拒绝，嵌套调用保留审批", async () => {
	const base = path.resolve(".tmp/tests/pimoon-shell-tools");
	await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	const repo = path.join(cwd, "repo");
	await fs.mkdir(repo, { recursive: true }); await fs.mkdir(agentDir);
	await execute("git", ["init", "--quiet"], { cwd: repo, windowsHide: true });
	await fs.writeFile(path.join(repo, "sentinel.txt"), "keep");
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { default: codemode } = await import("../../src/harness/extensions/codemode.ts");
	const config = defaultWebToolsConfig();
	for (const id of [...config.websearch.primary_providers, ...config.websearch.auxiliary_providers]) config.websearch[id].enabled = false;
	config.websearch.brave_api.enabled = true;
	config.websearch.brave_api.api_key = "fixture";
	vi.spyOn(webConfig, "loadWebToolsConfig").mockResolvedValue(config);
	// 工具注册、结果处理和审批使用正式实现，仅 HTTP 响应固定为合成内容。
	network.fetch.mockImplementation(async url => {
		if (url.hostname === "api.search.brave.com") return httpResponse(200, JSON.stringify({ grounding: { generic: [
			{ title: "Fixture docs", url: "https://93.184.216.34/docs", snippets: ["fixture search result"] },
		] } }), { "content-type": "application/json" });
		if (url.hostname === "93.184.216.34") return httpResponse(200, "fixture web content");
		throw new Error("意外网络请求");
	});
	const jobs = [
		{ tool: "bash", args: { command: "git status --short", workdir: "repo" } },
		{ tool: "codemode", args: { code: 'print(bash(command="git status --short", workdir="repo"))' } },
		{ tool: "bash", args: { command: "git clean -fd", workdir: "repo" } },
		{ tool: "codemode", args: { code: 'print(bash(command="git clean -fd", workdir="repo"))' } },
		{ tool: "bash", args: { command: "git status --short", workdir: ".." } },
		{ tool: "codemode", args: { code: 'print(bash(command="git status --short", workdir=".."))' } },
		{ tool: "websearch", args: { query: "fixture docs" } },
		{ tool: "codemode", args: { code: 'print(websearch(query="fixture docs"))' } },
		{ tool: "webfetch", args: { url: "https://93.184.216.34/docs" } },
		{ tool: "codemode", args: { code: 'print(webfetch(url="https://93.184.216.34/docs"))' } },
		{ tool: "webfetch", args: { url: "http://127.0.0.1/private" } },
		{ tool: "codemode", args: { code: 'print(webfetch(url="http://127.0.0.1/private"))' } },
	];
	const server = await startModelServer(request => jobs[request.messages.filter(message => message.role === "tool").length] ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", codemode: { mode: "only" }, retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [
					{ name: "codemode", builtin: true, factory: codemode },
					{ name: "approval-gate", factory: approvalGate },
					{ name: "bash-tool", factory: bashTool },
					{ name: "web-tools", factory: webTools },
				],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			return { ...await createAgentSessionFromServices({ services, sessionManager, tools: ["bash", "websearch", "webfetch", "codemode"] }), services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await runtime.session.prompt("Run the isolated Git workflow.");
			expect(server.requests).toHaveLength(jobs.length + 1);
			for (const request of server.requests) expect(request.tools?.map(tool => tool.function.name)).toEqual(["codemode"]);
			const description = server.requests[0]?.tools?.[0]?.function.description;
			for (const name of ["bash", "websearch", "webfetch"]) expect(description).toContain(`${name}(`);
			const hidden = new Set(codemodeHiddenDeclarations(runtime.session.getAllTools()));
			for (const name of ["bash", "websearch", "webfetch"]) expect(hidden.has(name)).toBe(true);
			const results = runtime.session.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(jobs.length);
			expect(results.map(result => result.isError)).toEqual([true, false, true, true, true, true, true, false, true, false, true, true]);
			for (const result of results.filter((_, index) => index % 2 === 0)) expect(JSON.stringify(result.content)).toContain("codemode");
			expect(JSON.stringify(results[1]?.content)).toContain("?? sentinel.txt");
			expect(JSON.stringify(results[3]?.content)).toMatch(/approval|审批/i);
			expect(JSON.stringify(results[5]?.content)).toContain("工作区");
			expect(JSON.stringify(results[7]?.content)).toContain("fixture search result");
			expect(JSON.stringify(results[9]?.content)).toContain("fixture web content");
			expect(JSON.stringify(results[11]?.content)).toMatch(/approval|审批/i);
			expect(network.fetch.mock.calls.every(([url]) => url.hostname !== "127.0.0.1")).toBe(true);
			expect(await fs.readFile(path.join(repo, "sentinel.txt"), "utf8")).toBe("keep");
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
