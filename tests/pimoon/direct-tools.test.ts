import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
it("CodeAct 只注册一个模型执行入口，保留函数权限、外部读取、凭据保护和 Python 状态", async () => {
	const base = path.resolve(".tmp/tests/pimoon-codeact-entry"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-")), cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { CodeAct } = await import("../../src/pimoon/codeact/session.ts");
	const { isExecutionResult } = await import("./native-result.ts");
	const { agentHome } = await import("../../src/pimoon/profile.ts");
	const { flushTelemetry, telemetryDirectory } = await import("../../src/pimoon/telemetry.ts");
	await fs.writeFile(path.join(cwd, "App.css"), ".message { border-radius: 20px 20px 8px 20px; }\r\n");
	const execute = (code: string): ModelResponse => ({ tool: "execute", args: { code, desc: "验证函数" } });
	const replies: ModelResponse[] = [execute('source=read(path="App.css")\nedit(path="App.css",edits=[{"old":"20px 20px 8px 20px","new":"20px"}])\nanswer=fixture_double(value=21)\nsource'), { text: "done" }];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories: [codeact.extension, { name: "file-tools", factory: fileTools }, { name: "fixture-function", factory(pi) {
				pi.registerTool({ name: "fixture_double", label: "Fixture", description: "Double fixture value.", exposure: "model-only", parameters: Type.Object({ value: Type.Number() }), outputSchema: Type.Number(),
					async execute(_id, { value }) { return { content: [{ type: "text", text: String(value * 2) }], structuredContent: value * 2, details: {} }; } });
			} }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "read", "write", "edit", "find", "grep", "ls", "fixture_double"] });
			codeact.bind(result.session);
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
			await runtime.session.prompt("Read and edit the fixture.");
			const results = () => runtime.session.messages.filter(isExecutionResult);
			expect(runtime.session.getAllTools().some(fn => fn.name === "codemode")).toBe(false);
			expect(results()[0]?.content).toEqual([{ type: "text", text: expect.stringContaining("20px 20px 8px 20px") }]);
			expect(await fs.readFile(path.join(cwd, "App.css"), "utf8")).toBe(".message { border-radius: 20px; }\r\n");
			for (const request of server.requests) expect(request.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
			expect(JSON.stringify(server.requests[0])).toContain("Functions:");
			expect(JSON.stringify(server.requests[0])).not.toContain("codemode(");
			replies.push(execute('assert answer==42\nassert "20px 20px 8px 20px" in source\nanswer'), { text: "done" });
			await runtime.session.prompt("Reuse Python memory.");
			expect(results().at(-1)?.content).toEqual([{ type: "text", text: "ok\n42\n" }]);
			const external = path.join(folder, "external.txt"); await fs.writeFile(external, "external fixture");
			replies.push(execute(`from pathlib import Path\nexternal=Path(${JSON.stringify(external)})\nassert external.read_text()=="external fixture"\nassert read(path=str(external),mode="raw")=="external fixture"\nassert "external fixture" in read(path=str(external))\nassert "external.txt" in ls(path=str(external.parent))\nassert "external.txt" in str(find(query="external",path=[str(external.parent)]))\nassert "external fixture" in str(grep(query="external fixture",path=[str(external)]))`), { text: "done" });
			await runtime.session.prompt("Analyze ordinary external files.");
			expect(results().at(-1)?.isError).toBe(false);
			const credential = path.join(agentHome, "auth.json"); await fs.writeFile(credential, JSON.stringify({ key: "SYNTHETIC_PRIVATE_CREDENTIAL" }));
			replies.push(execute(`read(path=${JSON.stringify(credential)},mode="raw")`), { text: "done" });
			await runtime.session.prompt("Try the protected synthetic credential.");
			expect(results().at(-1)?.isError).toBe(true);
			expect(JSON.stringify(results().at(-1)?.content)).not.toContain("SYNTHETIC_PRIVATE_CREDENTIAL");
			runtime.session.setActiveToolsByName([]);
			replies.push(execute('assert answer==42\nanswer+1'), { text: "done" });
			await runtime.session.prompt("Pure Python still works with no functions.");
			expect(results().at(-1)?.content).toEqual([{ type: "text", text: "ok\n43\n" }]);
			replies.push(execute('read(path="App.css")'), { text: "done" });
			await runtime.session.prompt("Disabled read cannot be called.");
			const last = results().at(-1);
			expect(last?.isError).toBe(true);
			expect(JSON.stringify(last?.content)).toContain("NameError");
			expect(runtime.session.messages.some(message => message.role === "toolResult")).toBe(true);
			await flushTelemetry();
			const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
			const records = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n");
			expect(records).toContain('"had_state":true');
			const events: Array<{ type: string; tool_call_id?: string; mono_ms: number }> = records.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
			const streamed = events.find(event => event.type === "code_stream_end");
			expect(streamed).toBeDefined();
			const started = events.find(event => event.type === "code_start" && event.tool_call_id === streamed?.tool_call_id);
			expect(started?.mono_ms).toBeGreaterThanOrEqual(streamed?.mono_ms ?? Infinity);
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
