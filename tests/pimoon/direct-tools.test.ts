import { afterEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { codemodeHiddenDeclarations } from "../../src/harness/codemode/loadout.ts";
import { agentHome } from "../../src/pimoon/profile.ts";
import { flushTelemetry, telemetryDirectory } from "../../src/pimoon/telemetry.ts";
import { createRuntimeResources } from "./runtime-resources.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";

afterEach(() => vi.unstubAllEnvs());

// 固定模型响应验证真实 SDK、Python 和宿主工具，不连接付费模型。
it("CodeAct 是唯一执行入口，拒绝直调，保留正文、变量和宿主能力开关", async () => {
	const base = path.resolve(".tmp/tests/pimoon-codeact-entry"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { default: codemode } = await import("../../src/harness/extensions/codemode.ts");
	const text = "/* 原始正文 context */\r\n".repeat(120) + ".message { border-radius: 20px 20px 8px 20px; }\r\n";
	await fs.writeFile(path.join(cwd, "App.css"), text);
	const edits = [{ old: "border-radius: 20px 20px 8px 20px;", new: "border-radius: 20px;" }];
	const replies: ModelResponse[] = [
		{ tool: "read", args: { path: "App.css" } },
		{ tool: "edit", args: { path: "App.css", edits } },
		{ tool: "codemode", args: { code: 'source=read(path="App.css"); source' } },
		{ tool: "codemode", args: { code: `print(edit(path="App.css", edits=${JSON.stringify(edits)}))\nassert "20px 20px 8px 20px" not in native_read("App.css")\nanswer=6*7\nprint(answer)` } },
		{ text: "done" },
	];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const names = ["read", "write", "edit", "find", "grep", "ls", "codemode"];
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [{ name: "codemode", builtin: true, factory: codemode }, { name: "file-tools", factory: fileTools }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			return { ...await createAgentSessionFromServices({ services, sessionManager, tools: names }), services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await expect.poll(async () => {
				await flushTelemetry();
				const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
				return (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n").includes('"type":"runtime_ready"');
			}, { timeout: 5000 }).toBe(true);
			expect(server.requests).toHaveLength(0);
			await runtime.session.prompt("Read App.css and unify the radius.");
			for (const request of server.requests) expect(request.tools?.map(tool => tool.function.name)).toEqual(["codemode"]);
			const description = server.requests[0]?.tools?.[0]?.function.description;
			expect(description).toContain("CodeAct: the only execution entry");
			expect(description).toContain("read(path: str, lines?: str, pages?: str) -> str|");
			expect(description).toContain("final top-level expression");
			expect(description).toContain("_ retains its full value");
			expect(description).toContain("edits: list[{old: str, new: str, replace_all?: bool}]");
			expect(description).not.toContain('"properties"');
			expect(description).not.toContain("bash(");
			const hidden = new Set(codemodeHiddenDeclarations(runtime.session.getAllTools()));
			expect(runtime.session.getActiveToolNames().filter(name => !hidden.has(name))).toEqual(["codemode"]);
			const results = runtime.session.messages.filter(message => message.role === "toolResult");
			expect(results.map(message => message.isError)).toEqual([true, true, false, false]);
			for (const result of results.slice(0, 2)) expect(JSON.stringify(result.content)).toContain("codemode");
			expect(JSON.stringify(results[2]?.content)).toContain("原始正文 context");
			expect(JSON.stringify(results[2]?.content)).toContain("border-radius: 20px 20px 8px 20px;");
			expect(await fs.readFile(path.join(cwd, "App.css"), "utf8")).toBe(text.replace("20px 20px 8px 20px", "20px"));
			replies.push({ tool: "codemode", args: { code: 'assert answer==42; assert "原始正文" in source; answer' } }, { text: "done" });
			await runtime.session.prompt("Continue using the Python variables.");
			expect(runtime.session.messages.filter(message => message.role === "toolResult").at(-1)).toMatchObject({ toolName: "codemode", isError: false });
			const external = path.join(folder, "external.txt");
			await fs.writeFile(external, "external fixture");
			replies.push({ tool: "codemode", args: { code: `from pathlib import Path
external=Path(${JSON.stringify(external)})
assert external.read_text()=="external fixture"
assert native_read(str(external))=="external fixture"
assert "external fixture" in read(path=str(external))
print("external checked")` } }, { text: "done" });
			await runtime.session.prompt("Analyze an external fixture in persistent Python and use the integrated read function.");
			expect(runtime.session.messages.filter(message => message.role === "toolResult").at(-1)?.isError).toBe(false);
			const credential = path.join(agentHome, "auth.json");
			await fs.writeFile(credential, JSON.stringify({ fixture: { type: "api_key", key: "SYNTHETIC_PRIVATE_CREDENTIAL" } }));
			replies.push({ tool: "codemode", args: { code: `print(read(path=${JSON.stringify(credential)}))` } }, { text: "done" });
			await runtime.session.prompt("Try the protected synthetic credential.");
			const denied = runtime.session.messages.filter(message => message.role === "toolResult").at(-1);
			expect(denied?.isError).toBe(true);
			expect(JSON.stringify(denied?.content)).not.toContain("SYNTHETIC_PRIVATE_CREDENTIAL");
			replies.push({ tool: "codemode", args: { code: `result=grep(query="SYNTHETIC_PRIVATE_CREDENTIAL", path=[${JSON.stringify(agentHome)}])
assert "auth.json" not in str(result)
print("protected search checked")` } }, { text: "done" });
			await runtime.session.prompt("Search the parent directory without exposing a protected credential.");
			expect(runtime.session.messages.filter(message => message.role === "toolResult").at(-1)?.isError).toBe(false);
			runtime.session.setActiveToolsByName(names.filter(name => name !== "read"));
			replies.push({ tool: "codemode", args: { code: 'print(read(path="App.css"))' } }, { text: "done" });
			await runtime.session.prompt("Try the disabled host function.");
			expect(server.requests.at(-1)?.tools?.[0]?.function.description).not.toContain("read(path:");
			expect(runtime.session.messages.filter(message => message.role === "toolResult").at(-1)?.isError).toBe(true);
			await flushTelemetry();
			const records = (await Promise.all((await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl")).map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n");
			expect(records).toContain('"reason":"codeact_required"');
			expect(records).toContain('"had_state":true');
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
