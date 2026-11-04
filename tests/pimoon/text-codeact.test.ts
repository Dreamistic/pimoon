import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { codeactStream } from "../../src/pimoon/codeact/stream.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());

it("API 不声明工具；一个文本 CodeAct 用外部函数、条件和循环完成十二次混合调用并跨轮复用", async () => {
	const base = path.resolve(".tmp/tests/pimoon-text-codeact"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	for (let index = 0; index < 8; index++) await fs.writeFile(path.join(cwd, `${index}.txt`), `value-${index}`);
	await fs.writeFile(path.join(cwd, "analysis_lib.py"), 'def choose(paths, rows):\n return [p for p,r in zip(paths,rows) if r["ok"] and int(p.split(".")[0])%2==0]\n');
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { default: codemode } = await import("../../src/harness/extensions/codemode.ts");
	const code = `from analysis_lib import choose
from statistics import mean
paths=[f"{i}.txt" for i in range(8)]
rows=batch("read", [{"path":p} for p in paths], limit=4)
selected=choose(paths, rows)
for p in selected:
 i=int(p.split(".")[0])
 edit(path=p, edits=[{"old":f"value-{i}","new":f"changed-{i}"}])
{"reads":len(rows),"edited":len(selected),"mean":mean(range(len(rows)))}`;
	const first = `准备批量分析\n<execute>\n${code}\n</execute>\n这些是未看到结果的臆测`;
	const replies: ModelResponse[] = [
		{ text: first, chunks: first.match(/[\s\S]{1,3}/gu) ?? [] },
		{ text: '<execute>\nassert len(rows)==8 and len(selected)==4\n{"retained":len(rows),"previous_mean":_["mean"]}\n</execute>' },
		{ text: "done" },
	];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [{ name: "codemode", builtin: true, factory: codemode }, { name: "file-tools", factory: fileTools }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["codemode", "read", "edit"] });
			result.session.agent.streamFunction = codeactStream(result.session.agent.streamFunction);
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await runtime.session.prompt("Complete the isolated fixture workflow without print.");
			expect(server.requests).toHaveLength(3);
			for (const request of server.requests) {
				expect(request.tools ?? []).toEqual([]);
				expect(request.messages.some(message => message.role === "tool" || message.tool_call_id)).toBe(false);
				expect(JSON.stringify(request)).not.toContain('"tool_calls"');
			}
			const results = runtime.session.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results.map(message => message.isError), JSON.stringify(results.map(message => message.content))).toEqual([false, false]);
			expect(results[0]?.details).toMatchObject({ metrics: { internal_tool_calls: 12, internal_tool_failures: 0, auto_results: 4 } });
			expect(JSON.stringify(results[0]?.content)).not.toContain("value-1");
			expect(JSON.stringify(results[1]?.content)).toContain("previous_mean");
			expect(JSON.stringify(runtime.session.messages)).not.toContain("这些是未看到结果的臆测");
			for (let index = 0; index < 8; index++) expect(await fs.readFile(path.join(cwd, `${index}.txt`), "utf8")).toBe(`${index % 2 === 0 ? "changed" : "value"}-${index}`);
			const unsafe = '<execute>\nedit(path="0.txt",edits=[{"old":"changed-0","new":"must not run"}])';
			replies.push({ text: unsafe });
			await runtime.session.prompt("Unclosed fixture; must not execute.");
			expect(runtime.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
			expect(await fs.readFile(path.join(cwd, "0.txt"), "utf8")).toBe("changed-0");
			runtime.session.setActiveToolsByName([]);
			replies.push({ text: unsafe + "\n</execute>" });
			await runtime.session.prompt("Disabled fixture; must not execute.");
			expect(runtime.session.messages.filter(message => message.role === "toolResult")).toHaveLength(2);
			expect(await fs.readFile(path.join(cwd, "0.txt"), "utf8")).toBe("changed-0");
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
