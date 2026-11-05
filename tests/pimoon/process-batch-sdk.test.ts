import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import processFunctions from "../../src/harness/extensions/codeact-functions.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import { isExecutionResult, executionMetrics } from "./native-result.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
const job = (code: string, extra: { timeout?: number } = {}) => ({ argv: [process.execPath, "-e", code], ...extra });
async function fixture(codes: string[], gate = false) {
	const base = path.resolve(".tmp/tests/process-batch-sdk"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-")), cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const replies: ModelResponse[] = [...codes.map(code => ({ tool: "execute", args: { code, desc: "进程验证" } })), { text: "done" }];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories: [codeact.extension, { name: "process", factory: processFunctions }, ...(gate ? [{ name: "approval-gate", factory: approvalGate }] : [])], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "process_run"] });
			codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		return { cwd, session: runtime.session, server, async close() { try { await runtime.dispose(); } finally { await server.close(); } } };
	} catch (error) { await server.close(); throw error; }
}

it("真实 SDK 的进程批次有界并发、部分失败不启动依赖项，命令超时后跨轮变量仍在", async () => {
	const jobs = [job("setTimeout(()=>console.log('first'),250)"), job("console.error('fixture-failure');process.exit(7)"), job("console.log('last')")];
	const codes = [
		`saved=41\nrows=batch("process_run",json.loads(${JSON.stringify(JSON.stringify(jobs))}))\nassert [x["value"]["stdout"].strip() for x in rows if x["ok"]]==["first","last"]\nassert not rows[1]["ok"]\nif all(x["ok"] for x in rows):\n process_run(argv=${JSON.stringify(job("require('node:fs').writeFileSync('must-not-run','bad')").argv)})`,
		`process_run(**json.loads(${JSON.stringify(JSON.stringify(job("setInterval(()=>{},1000)", { timeout: 0.3 })))}))\nsaved=99`,
		`assert saved==41\nsaved+=1\nprocess_run(argv=${JSON.stringify(job("require('node:fs').writeFileSync('producer.txt','42')").argv)})\nvalue=process_run(argv=${JSON.stringify(job("console.log(require('node:fs').readFileSync('producer.txt','utf8'))").argv)})\nassert value["stdout"].strip()=="42"\nsaved`,
	];
	const f = await fixture(codes);
	try {
		let active = 0, peak = 0;
		f.session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === "process_run") { active++; peak = Math.max(peak, active); }
			if (event.type === "tool_execution_end" && event.toolName === "process_run") active--;
		});
		await f.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
		await f.session.prompt("Run isolated process fixtures.");
		const results = f.session.messages.filter(isExecutionResult);
		expect(results).toHaveLength(3);
		expect(results.map(result => result.isError)).toEqual([false, true, false]);
		expect(executionMetrics(results[0])).toMatchObject({ internal_tool_calls: 3, internal_tool_failures: 1, tool_failure_count: 1 });
		expect(executionMetrics(results[2]).python_pid).toBe(executionMetrics(results[0]).python_pid);
		expect(JSON.stringify(results[2]?.content)).toContain("42");
		expect(peak).toBe(2); expect(active).toBe(0);
		await expect(fs.access(path.join(f.cwd, "must-not-run"))).rejects.toThrow();
		expect(f.server.requests).toHaveLength(4);
		for (const request of f.server.requests) expect(request.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
	} finally { await f.close(); }
});

it("批量进程逐项经过真实审批，未批准时不产生任何进程副作用", async () => {
	const jobs = [job("require('node:fs').writeFileSync('denied-a','bad')"), job("require('node:fs').writeFileSync('denied-b','bad')")];
	const f = await fixture([`rows=batch("process_run",json.loads(${JSON.stringify(JSON.stringify(jobs))}))\nassert all(not item["ok"] for item in rows)`], true);
	try {
		await f.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
		await f.session.prompt("Approval must still block batch processes.");
		const result = f.session.messages.find(isExecutionResult);
		expect(result?.isError).toBe(false);
		expect(executionMetrics(result)).toMatchObject({ internal_tool_calls: 2, internal_tool_failures: 2 });
		expect(JSON.stringify(result?.content)).toMatch(/approval|审批/iu);
		for (const file of ["denied-a", "denied-b"]) await expect(fs.access(path.join(f.cwd, file))).rejects.toThrow();
	} finally { await f.close(); }
});
