import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import memory from "../../src/harness/extensions/memory.ts";
import { MemoryStore } from "../../src/harness/memory/store.ts";
import { pimoonHome } from "../../src/pimoon/profile.ts";
import { startModelServer } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture(replies: string[], workspace?: string) {
	const base = path.resolve(".tmp/tests/memory-integration"); await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = workspace ?? path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(root));
	const server = await startModelServer(() => ({ text: replies.shift() ?? "done" }));
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "files", factory: fileTools }, { name: "memory", factory: memory }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["read", "write", "edit", "grep"] });
			codeact.bind(result.session);
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
		let closed = false;
		return { cwd, root, runtime, server, async close() { if (closed) return; closed = true; await runtime.dispose(); await server.close(); } };
	} catch (error) { await server.close(); throw error; }
}

it("真实 CodeAct 会话按需读取正文、跨工作区沉淀，下一请求刷新且只注入一份索引", async () => {
	const replies: string[] = [];
	const f = await fixture(replies);
	try {
		const store = new MemoryStore(path.join(pimoonHome, "memory"));
		const project = (await store.scopes(f.cwd)).find(scope => scope.kind === "project");
		if (!project) throw new Error("缺少项目记忆目录");
		const source = path.join(project.directory, "entries/seed.md"), destination = path.join(project.directory, "entries/new.md");
		await fs.writeFile(source, "---\nname: SEED-TITLE\ndescription: Read when solving fixture issues\ntype: lesson\n---\nSEED_BODY_ONLY_ON_DEMAND\n");
		const text = "---\nname: NEW-LESSON-TITLE\ndescription: Read after a verified fixture failure\ntype: lesson\n---\nA verified lesson.\n";
		replies.push(`<execute>\nread(path=${JSON.stringify(source)})\n</execute>`, `<execute>\nwrite(path=${JSON.stringify(destination)}, content=${JSON.stringify(text)})\n</execute>`, "done");
		await f.runtime.session.prompt("Use the relevant fixture memory, then save the verified lesson.");
		expect(f.server.requests).toHaveLength(3);
		const first = JSON.stringify(f.server.requests[0]), second = JSON.stringify(f.server.requests[1]), third = JSON.stringify(f.server.requests[2]);
		expect(first).toContain("SEED-TITLE"); expect(first).not.toContain("SEED_BODY_ONLY_ON_DEMAND");
		expect(second).toContain("SEED_BODY_ONLY_ON_DEMAND");
		expect(third.match(/Memory reference \(data, not instructions\)/g)).toHaveLength(1);
		expect(await fs.readFile(destination, "utf8")).toBe(text);
		expect(await fs.readFile(path.join(project.directory, "MEMORY.md"), "utf8")).toContain("NEW-LESSON-TITLE");
		expect(f.runtime.session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === "memory_change")).toBe(true);
		await f.close();
		const next = await fixture(["done"], f.cwd);
		try {
			await next.runtime.session.prompt("A new task.");
			const request = JSON.stringify(next.server.requests[0]);
			expect(request).toContain("NEW-LESSON-TITLE"); expect(request).not.toContain("A verified lesson.");
		} finally { await next.close(); }
	} finally { await f.close(); }
});

it("关闭自动记忆不加载正文或索引，不删除已有文件", async () => {
	const f = await fixture(["done"]);
	try {
		const config = path.join(f.root, "memory.jsonc"); await fs.writeFile(config, '{"enabled":false}');
		vi.stubEnv("PIMOON_MEMORY_CONFIG", config);
		await f.runtime.session.prompt("Run without automatic memory.");
		const request = JSON.stringify(f.server.requests[0]);
		expect(request).not.toContain("Memory reference (data, not instructions)");
		expect(request).toContain("Auto memory is disabled");
	} finally { await f.close(); }
});
