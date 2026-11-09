import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import processFunctions from "../../src/harness/extensions/codeact-functions.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import webTools from "../../src/harness/extensions/web-tools.ts";
import * as webConfig from "../../src/harness/web-tools/config.ts";
import type { WebHttpFetch } from "../../src/harness/web-tools/network/types.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { defaultWebToolsConfig } from "../harness/web-tools/config-fixture.ts";
import { httpResponse } from "../helpers/http.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

vi.mock("../../src/harness/approval/advisor.ts", async importOriginal => ({
	...await importOriginal<typeof import("../../src/harness/approval/advisor.ts")>(),
	adviseApproval: async (request: { tool: string }) => ({ decision: request.tool === "process_run" ? "deny" : "allow", explanation: "fixture decision" }),
}));
const network = vi.hoisted(() => ({ fetch: vi.fn<WebHttpFetch>() }));
vi.mock("undici/index.js", async importOriginal => ({ ...await importOriginal<typeof import("undici")>(), fetch: network.fetch }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("进程、搜索、网页与 HTTP 都是 CodeAct 函数，整段审批拒绝进程但不拦截允许的内网请求", async () => {
	const base = path.resolve(".tmp/tests/pimoon-function-approvals"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-")), cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	const approval = path.join(folder, "approval-ai.jsonc"); await fs.writeFile(approval, "{}");
	vi.stubEnv("PIMOON_APPROVAL_AI_CONFIG", approval);
	const protectedDir = path.join(os.homedir(), ".ssh"); await fs.mkdir(protectedDir, { recursive: true });
	await fs.writeFile(path.join(cwd, "sentinel.txt"), "keep");
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { CodeAct } = await import("../../src/pimoon/codeact/session.ts");
	const { isExecutionResult } = await import("./native-result.ts");
	const config = defaultWebToolsConfig();
	for (const id of [...config.websearch.primary_providers, ...config.websearch.auxiliary_providers]) config.websearch[id].enabled = false;
	config.websearch.brave_api.enabled = true; config.websearch.brave_api.api_key = "fixture";
	vi.spyOn(webConfig, "loadWebToolsConfig").mockResolvedValue(config);
	network.fetch.mockImplementation(async url => {
		if (url.hostname === "api.search.brave.com") return httpResponse(200, JSON.stringify({ grounding: { generic: [{ title: "Fixture docs", url: "https://93.184.216.34/docs", snippets: ["fixture search result"] }] } }), { "content-type": "application/json" });
		if (url.hostname === "93.184.216.34" || url.hostname === "127.0.0.1") return httpResponse(200, "fixture web content");
		throw new Error("意外网络请求");
	});
	const code = [
		'subprocess.run(["git","clean","-fd"])',
		'websearch(query="fixture docs")',
		'webfetch(url="https://93.184.216.34/docs")',
		'http(url="https://93.184.216.34/docs",mode="probe")',
		'http(url="http://127.0.0.1/private",mode="probe")',
		`subprocess.run(["git","status","--short"],cwd=${JSON.stringify(protectedDir)})`,
	];
	const replies: ModelResponse[] = code.map(source => ({ tool: "execute", args: { code: source, desc: "验证权限" } })); replies.push({ text: "done" });
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories: [codeact.extension,
				{ name: "approval-gate", factory: approvalGate }, { name: "process", factory: processFunctions }, { name: "web-tools", factory: webTools }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "process_run", "websearch", "webfetch", "http"] });
			codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await runtime.session.prompt("Run isolated function workflows.");
			expect(server.requests).toHaveLength(code.length + 1);
			for (const request of server.requests) expect(request.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
			const results = runtime.session.messages.filter(isExecutionResult);
			expect(results.map(result => ({ isError: result.isError })), JSON.stringify(results.map(result => result.content))).toEqual([expect.objectContaining({ isError: true }), expect.objectContaining({ isError: false }), expect.objectContaining({ isError: false }), expect.objectContaining({ isError: false }), expect.objectContaining({ isError: false }), expect.objectContaining({ isError: true })]);
			expect(JSON.stringify(results[0]?.content)).toMatch(/AI denied|approval|审批/iu);
			expect(JSON.stringify(results[1]?.content)).toContain("fixture search result");
			expect(JSON.stringify(results[2]?.content)).toContain("fixture web content");
			expect(JSON.stringify(results[3]?.content)).toContain("total_ms");
			expect(JSON.stringify(results[4]?.content)).toContain("total_ms");
			expect(JSON.stringify(results[5]?.content)).toContain("凭据");
			expect(network.fetch.mock.calls.some(([url]) => url.hostname === "127.0.0.1")).toBe(true);
			expect(await fs.readFile(path.join(cwd, "sentinel.txt"), "utf8")).toBe("keep");
			replies.push({ tool: "webfetch", args: { url: "https://93.184.216.34/docs" } });
			await runtime.session.prompt("Native tool calls must not execute.");
			expect(runtime.session.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
