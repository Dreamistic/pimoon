import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import type { ConfirmCodeAct } from "../../src/pimoon/codeact/confirmation.ts";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

export const action = (code: string, confirm?: string): ModelResponse => ({
    tool: "execute", args: { code, desc: "隔离验证", ...(confirm ? { confirm } : {}) },
});
export const marker = 'from pathlib import Path\nPath("marker.txt").write_text("once", encoding="utf-8")';
export async function fixture(replies: ModelResponse[], confirm?: ConfirmCodeAct, guards: InlineExtension[] = [], reopen?: { root: string; sessionFile: string }, tools = ["execute", "write", "read"]) {
	const base = path.resolve(".tmp/tests/native-codeact-candidate"); await fs.mkdir(base, { recursive: true });
	const root = reopen?.root ?? await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(agentDir, { recursive: true });
	vi.stubEnv("PIMOON_RESOURCE_DIR", reopen ? path.join(root, "resources") : await createRuntimeResources(root));
	const server = await startModelServer(() => {
		return replies.shift() ?? { text: "done" };
	});
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));

	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct(confirm);
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "file-tools", factory: fileTools }, ...guards],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools });
			codeact.bind(result.session);
            if (!result.session.getActiveToolNames().includes("execute")) throw new Error("execute 未激活: " + JSON.stringify({ active: result.session.getActiveToolNames(), extensions: services.resourceLoader.getExtensions().errors, tools: result.session.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name) }));
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: reopen ? SessionManager.open(reopen.sessionFile) : SessionManager.create(cwd, path.join(root, "sessions")) });
		await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
		return { root, cwd, runtime, server, results: () => runtime.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "execute"),
			async close() { await runtime.dispose(); await server.close(); } };
	} catch (error) { await server.close(); throw error; }
}
