import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { flushTelemetry, telemetryDirectory } from "../../src/pimoon/telemetry.ts";
import { startModelServer } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";
import { registerTelemetry, type TelemetryService } from "../../src/harness/telemetry/service.ts";
import { createLiveTelemetryReport } from "../../src/harness/telemetry-report/live.ts";

afterEach(() => vi.unstubAllEnvs());

it("CodeAct 在 Python 内处理读取结果，自动返回摘要并保留部分失败", async () => {
	const base = path.resolve(".tmp/tests/pimoon-batch-tools");
	await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	const resources = await createRuntimeResources(folder);
	for (let i = 0; i < 8; i++) await fs.writeFile(path.join(cwd, `${i}.txt`), `value-${i}`);
	await fs.writeFile(path.join(folder, "outside.txt"), "outside sentinel");
	vi.stubEnv("PIMOON_RESOURCE_DIR", resources);
	const { CodeAct } = await import("../../src/pimoon/codeact/session.ts");
	const { isExecutionResult } = await import("./native-result.ts");
	const code = [
		'jobs=[{"path":f"{i}.txt"} for i in range(8)]+[{"path":"missing.txt"},{"path":"../outside.txt"}]',
		'items=batch("read", jobs, limit=3)',
		'assert all(item["ok"] and f"value-{i}" in item["value"] for i,item in enumerate(items[:8]))',
		'assert not items[8]["ok"] and items[9]["ok"] and "outside sentinel" in items[9]["value"]',
		'"read={} failed={}".format(sum(item["ok"] for item in items), sum(not item["ok"] for item in items))',
	].join("\n");
	const server = await startModelServer(request => request.messages.some(message => message.role === "tool") ? { text: "done" } : { tool: "execute", args: { code, desc: "批量读取" } });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const collectors: TelemetryService[] = [];
	try {
		const manager = SessionManager.inMemory(cwd);
		const create = () => createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "file-tools", factory: pi => {
					const service = registerTelemetry(pi); collectors.push(service); fileTools(pi, service);
				} }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "read"] });
			codeact.bind(result.session);
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: manager });
		const runtime = await create();
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await expect.poll(async () => {
				await flushTelemetry();
				const files = await fs.readdir(telemetryDirectory);
				return (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n").includes('"type":"runtime_ready"');
			}, { timeout: 5000 }).toBe(true);
			expect(server.requests).toHaveLength(0);
			await runtime.session.prompt("Read the fixture batch and report counts.");
			expect(server.requests).toHaveLength(2);
			const results = runtime.session.messages.filter(isExecutionResult);
			expect(results).toHaveLength(1);
			expect(results[0]?.isError).toBe(false);
			const text = JSON.stringify(results[0]?.content);
			expect(text).toContain("read=9 failed=1");
			expect(text).toContain("tool_failures");
			expect(text).not.toContain("outside sentinel");
		} finally { await runtime.dispose(); }
		const resumed = await create();
		try {
			await resumed.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await expect.poll(async () => {
				await flushTelemetry();
				const files = await fs.readdir(telemetryDirectory);
				const records = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n");
				return records.split('"type":"runtime_ready"').length - 1;
			}, { timeout: 5000 }).toBe(2);
			await resumed.session.prompt("Continue without replaying completed work.");
			expect(server.requests).toHaveLength(3);
			expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("Python 内存为空");
		} finally { await resumed.dispose(); }
		const records = (await Promise.all((await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl")).map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("\n");
		const events: unknown[] = records.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		const toolEvents = events.filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "type" in event && event.type === "tool_end");
		expect(toolEvents.filter(event => event.tool === "read")).toHaveLength(10);
		expect(toolEvents.filter(event => event.tool === "read" && event.is_error)).toHaveLength(1);
		expect(toolEvents.filter(event => event.tool === "codemode")).toHaveLength(0);
		const runtimeEvents = events.filter((event): event is Record<string, unknown> => typeof event === "object" && event !== null && "type" in event);
		expect(runtimeEvents.filter(event => event.type === "runtime_created")).toHaveLength(2);
		const ready = runtimeEvents.find(event => event.type === "runtime_ready");
		expect(ready?.prewarmed).toBe(true);
		const executed = runtimeEvents.find(event => event.type === "code_end");
		expect(executed?.metrics).toMatchObject({ python_pid: ready?.python_pid, outcome: "tool_partial_failure", internal_tool_calls: 10, internal_tool_failures: 1, batch_calls: 1, expression_results: 1 });
		expect(runtimeEvents.find(event => event.type === "batch_end")).toMatchObject({ jobs: 10, completed: 10, failed: 1, code_call_id: executed?.tool_call_id });
		const bridgeEnds = runtimeEvents.filter(event => event.type === "bridge_tool_end");
		expect(bridgeEnds).toHaveLength(10);
		expect(bridgeEnds.map(event => event.tool_call_id).sort()).toEqual(toolEvents.filter(event => event.tool === "read").map(event => event.tool_call_id).sort());
		const first = collectors[0];
		if (!first) throw new Error("缺少工具遥测采集器");
		const snapshot = first.snapshot(), report = createLiveTelemetryReport(snapshot).report;
		expect(report.execution).toMatchObject({ direct_calls: 1, nested_calls: 10, codeact: { calls: 1, metrics_samples: 1, outcomes: { tool_partial_failure: 1 } } });
		const calls = snapshot.records.filter(record => record.type === "call");
		expect(calls).toHaveLength(11);
		for (const call of calls) {
			expect(call.application_run_id).toBe(executed?.run);
			expect(call.agent_run_id).toBe(executed?.agent_run_id);
			expect(call.model_request_id).toBe(executed?.model_request_id);
			expect(call.session_id).toBe(executed?.session_id);
		}
		expect(records).not.toContain(code);
		expect(records).not.toContain("Read the fixture batch and report counts.");
		expect(runtimeEvents.some(event => event.type === "session_shutdown")).toBe(true);
	} finally { await server.close(); }
});
