import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { registerTelemetry, type TelemetryService } from "../../src/harness/telemetry/service.ts";
import { createLiveTelemetryReport } from "../../src/harness/telemetry-report/live.ts";
import { createRuntimeResources } from "./runtime-resources.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";

// 只缩短运行超时，仍执行真实 Python/Rust、SDK 生命周期和宿主工具。
vi.mock("../../src/pimoon/runtime.mjs", async importOriginal => {
	const original = await importOriginal<typeof import("../../src/pimoon/runtime.mjs")>();
	return { ...original, Runtime: class extends original.Runtime {
		constructor(options: ConstructorParameters<typeof original.Runtime>[0]) { super({ ...options, timeoutMs: 1500 }); }
	} };
});
afterEach(() => vi.unstubAllEnvs());

it("真实执行的部分失败、Python 异常与超时都进入会话报告，原生操作不遗漏", async () => {
	const base = path.resolve(".tmp/tests/execution-telemetry"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const { CodeAct } = await import("../../src/pimoon/codeact/session.ts");
	const execute = (code: string): ModelResponse => ({ tool: "execute", args: { code, desc: "执行遥测夹具" } });
	const source = "SYNTHETIC_PRIVATE_CONTENT";
	await fs.writeFile(path.join(cwd, "fixture.txt"), source);
	const replies: ModelResponse[] = [
		execute(`from pathlib import Path
assert native_read("fixture.txt")==${JSON.stringify(source)}
try:
 native_read("missing.txt")
except RuntimeError:
 pass
assert Path("fixture.txt").read_text()==${JSON.stringify(source)}
Path("saved.txt").write_text("saved")
first,second=parallel([(read,{"path":"fixture.txt"}),(read,{"path":"fixture.txt"})])
try:
 read(path="missing.txt")
except RuntimeError:
 pass
{"ok":True}`),
		execute("if :"),
		execute("while True: pass"),
		{ text: "done" },
	];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	let service: TelemetryService | undefined;
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "tools", factory(pi) { service = registerTelemetry(pi); fileTools(pi, service); } }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "read"] });
			codeact.bind(result.session);
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		try {
			await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
			await runtime.session.prompt("Run the fixture.");
			if (!service) throw new Error("缺少遥测服务");
			const snapshot = service.snapshot();
			const code = snapshot.records.filter(record => record.type === "call" && record.tool === "execute");
			expect(code).toHaveLength(3);
			expect(code[0]).toMatchObject({ status: "success", fields: { outcome: "tool_partial_failure", internal_tool_calls: 3, internal_tool_failures: 1,
				batch_calls: 1, batch_jobs: 2, batch_completed: 2, batch_failures: 0, batch_peak_concurrency: 2,
				native_read_calls_observed: 2, native_read_failures: 1, native_read_result_chars: source.length, fs_open_write_attempts: 1 } });
			expect(code[1]).toMatchObject({ status: "error", fields: { outcome: "python_error", error_type: "SyntaxError", metrics_complete: true, state_reused: true } });
			expect(code[2]).toMatchObject({ status: "error", fields: { outcome: "timeout", metrics_complete: false, state_lost: true, internal_tool_calls: 0 } });
			const report = createLiveTelemetryReport(snapshot).report;
			expect(report.execution.host.calls).toBe(3);
			expect(report.execution.codeact.clean_success_rate).toMatchObject({ numerator: 0, samples: 3 });
			expect(report.execution.codeact.native.file_reads.total).toBeGreaterThan(0);
			expect(report.execution.codeact.native.read_failures).toEqual({ samples: 2, total: 1 });
			expect(JSON.stringify(snapshot)).not.toContain(source);
			expect(JSON.stringify(snapshot)).not.toContain("native_read_trace");
			expect(code.every(record => record.type === "call" && record.fields?.["telemetry_result_limited"] !== true)).toBe(true);
		} finally { await runtime.dispose(); }
	} finally { await server.close(); }
});
