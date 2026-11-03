import { afterEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { codemodeHiddenDeclarations } from "../../src/harness/codemode/loadout.ts";
import { flushTelemetry, telemetryDirectory } from "../../src/pimoon/telemetry.ts";
import { createRuntimeResources } from "./runtime-resources.ts";
import { startModelServer } from "../cli/model-server.ts";

afterEach(() => vi.unstubAllEnvs());

// 本地固定响应验证 SDK 声明和真实文件工具，不连接模型服务。
it("CodeAct 后台预热不请求模型，read/edit 仍直接完成、不经过 Python", async () => {
	const base = path.resolve(".tmp/tests/pimoon-direct-tools"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { default: codemode } = await import("../../src/harness/extensions/codemode.ts");
	const text = "/* source context */\r\n".repeat(120) + ".message { border-radius: 20px 20px 8px 20px; }\r\n";
	await fs.writeFile(path.join(cwd, "App.css"), text);
	const server = await startModelServer(request => {
		const count = request.messages.filter(message => message.role === "tool").length;
		if (count === 0) return { tool: "read", args: { path: "App.css" } };
		if (count === 1) return { tool: "edit", args: { path: "App.css", edits: [{ old: "border-radius: 20px 20px 8px 20px;", new: "border-radius: 20px;" }] } };
		return { text: "done" };
	});
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", codemode: { mode: "only" }, retry: { enabled: false }, compaction: { enabled: false } }));
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
				const files = await fs.readdir(telemetryDirectory);
				return (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n").includes('"type":"runtime_ready"');
			}, { timeout: 5000 }).toBe(true);
			expect(server.requests).toHaveLength(0);
			await runtime.session.prompt("Read App.css and unify the radius.");
			expect(server.requests[0]?.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(names));
			const description = server.requests[0]?.tools?.find(tool => tool.function.name === "codemode")?.function.description;
			expect(description).toContain("direct tools"); expect(description).not.toContain('"properties"');
			expect(description).toContain("batch(name, jobs, limit=6)");
			const hidden = new Set(codemodeHiddenDeclarations(runtime.session.getAllTools()));
			const projected = runtime.session.getActiveToolNames().filter(name => !hidden.has(name));
			expect(projected).toEqual(server.requests[0]?.tools?.map(tool => tool.function.name));
			expect(JSON.stringify(server.requests[1]?.messages)).toContain("border-radius: 20px 20px 8px 20px;");
			expect(await fs.readFile(path.join(cwd, "App.css"), "utf8")).toBe(text.replace("20px 20px 8px 20px", "20px"));
			const results = runtime.session.messages.filter(message => message.role === "toolResult");
			expect(results.map(message => message.toolName)).toEqual(["read", "edit"]);
			expect(results.every(message => !message.isError)).toBe(true);
			await flushTelemetry();
			const records = (await Promise.all((await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl")).map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n");
			expect(records).toContain('"prewarmed":true');
			expect(records).not.toContain('"type":"code_start"');
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
