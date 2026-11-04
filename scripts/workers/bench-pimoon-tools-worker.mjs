import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
const [app, bundle, home] = process.argv.slice(2);
const { fileTools, CodeAct, startModelServer, disposeLsp, flushTelemetry, telemetryStats } = await import(pathToFileURL(bundle).href);
const factories = [{ name: "file-tools", factory: fileTools }];
const codeAct = CodeAct ? new CodeAct() : undefined;
if (codeAct) factories.unshift(codeAct.extension);
const cwd = path.join(home, "workspace"), agentDir = path.join(home, "agent");
await fs.mkdir(cwd); await fs.mkdir(agentDir);
await fs.mkdir(path.join(cwd, "src"));
await fs.writeFile(path.join(cwd, ".gitignore"), "ignored/\n");
await fs.mkdir(path.join(cwd, "ignored"));
await fs.writeFile(path.join(cwd, "ignored/hidden.txt"), "not visible");
for (let i = 0; i < 128; i++) await fs.writeFile(path.join(cwd, "src", `file-${i}.ts`), `export function item${i}() { return ${i}; }\n// fixture\n`);
const textFixture = "alpha\nbeta\ngamma\n".repeat(32);
await fs.writeFile(path.join(cwd, "note.txt"), textFixture);
await fs.mkdir(path.join(cwd, "notes"));
for (let i = 0; i < 8; i++) await fs.writeFile(path.join(cwd, "notes", `${i}.txt`), textFixture);
const jobs = [];
for (let round = 0; round < 10; round++) jobs.push(
	{ label: "ls", tool: "ls", args: { path: "src" } },
	{ label: "read", tool: "read", args: { path: "note.txt" } },
	{ label: "find", tool: "find", args: { query: "file-42", path: ["src"] } },
	{ label: "grep-scoped", tool: "grep", args: { query: "alpha", mode: "literal", path: ["note.txt"] } },
	{ label: "grep-code", tool: "grep", args: { query: "item42", mode: "literal", path: ["src"] } },
	{ label: "write", tool: "write", args: { path: "changed.txt", content: `round-${round}` } },
	{ label: "edit", tool: "edit", args: { path: "changed.txt", edits: [{ old: `round-${round}`, new: `done-${round}` }] } },
);
if (app === "pimoon") for (let round = 0; round < 10; round++) jobs.push(
	{ label: "CodeAct-print", tool: "codeact", args: { code: 'print("ready")' } },
	{ label: "CodeAct-batch-8", tool: "codeact", args: { code: 'values=batch("read", [{"path":f"notes/{i}.txt"} for i in range(8)], limit=6)\nprint(len(values))' } },
	{ label: "CodeAct-sequential-8", tool: "codeact", args: { code: 'values=[read(path=f"notes/{i}.txt") for i in range(8)]\nprint(len(values))' } },
);
// pimoon 基准也使用真实的唯一执行入口，不以被拒绝的直调充当性能样本。
if (app === "pimoon") for (const job of jobs) {
	if (job.tool === "codeact") continue;
	const code = `print(${job.tool}(**json.loads(${JSON.stringify(JSON.stringify(job.args))})))`;
	job.tool = "codeact";
	job.args = { code };
}
let cursor = 0;
const server = await startModelServer(() => cursor < jobs.length ? (() => { const job = jobs[cursor++]; return codeAct ? { text: `<execute>\n${job.args.code}\n</execute>` } : { tool: job.tool, args: job.args }; })() : { text: "done" });
await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
	baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
const names = ["read", "write", "edit", "find", "grep", "ls"];
const samples = [];
const failures = [];
const expected = { ls: "file-42.ts", read: "alpha", find: "src/file-42.ts", "grep-scoped": "alpha", "grep-code": "item42", "CodeAct-print": "ready", "CodeAct-batch-8": "\n8\n", "CodeAct-sequential-8": "\n8\n" };
const started = new Map();
let jobIndex = 0;
let runtime;
try {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories: factories, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
		const result = await createAgentSessionFromServices({ services, sessionManager, tools: names });
		codeAct?.bind(result.session, observe);
		return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
	runtime.session.subscribe(observe);
	await runtime.session.prompt("Run the local deterministic tool fixtures.");
	function observe(event) {
		if (event.type === "tool_execution_start" && !event.parentToolCallId) started.set(event.toolCallId, { at: performance.now(), job: jobs[jobIndex++] });
		if (event.type !== "tool_execution_end") return;
		const span = started.get(event.toolCallId);
		if (!span) return;
		const text = event.result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		if (event.isError || expected[span.job.label] && !text.includes(expected[span.job.label])) failures.push({ label: span.job.label, text });
		samples.push({ label: span.job.label, ms: performance.now() - span.at, outputTokens: countTokens(text), inputTokens: countTokens(JSON.stringify(span.job.args)) });
		started.delete(event.toolCallId);
	}
	if (samples.length !== jobs.length) throw new Error(`Missing samples: ${samples.length}/${jobs.length}`);
	if (failures.length) throw new Error(JSON.stringify(failures));
	if (await fs.readFile(path.join(cwd, "changed.txt"), "utf8") !== "done-9") throw new Error("Mutation did not complete");
	const declarations = JSON.stringify(server.requests[0].tools ?? []);
	const codeActPrompt = codeAct ? server.requests[0].messages.filter(message => message.role === "system").map(message => message.content).join("\n") : "";
	const rows = [...new Set(samples.map(sample => sample.label))].map(label => {
		const values = samples.filter(sample => sample.label === label), warm = values.slice(1).map(value => value.ms).sort((a, b) => a - b);
		return { operation: label, firstMs: +values[0].ms.toFixed(2), medianMs: +warm[Math.floor(warm.length / 2)].toFixed(2), p95Ms: +warm[Math.ceil(warm.length * .95) - 1].toFixed(2), inputTokens: values[0].inputTokens, outputTokens: values[0].outputTokens };
	});
	let telemetry, prewarm;
	if (app === "pimoon") {
		await flushTelemetry();
		const telemetryRoot = path.join(process.env.PIMOON_HOME, "telemetry");
		const events = [];
		for (const run of await fs.readdir(telemetryRoot)) for (const file of await fs.readdir(path.join(telemetryRoot, run))) {
			if (file.endsWith(".jsonl")) events.push(...(await fs.readFile(path.join(telemetryRoot, run, file), "utf8")).trim().split("\n").map(line => JSON.parse(line)));
		}
		const settled = events.findLast(event => event.type === "agent_settled");
		telemetry = { elapsedMs: settled?.elapsed_ms, eventCount: events.length, ...telemetryStats() };
		if (!telemetry.complete || telemetry.pendingBytes !== 0 || events.some((event, index) => event.seq !== index + 1)) throw new Error("Telemetry incomplete or out of order");
		const ready = events.find(event => event.type === "runtime_ready");
		const firstCall = events.find(event => event.type === "code_start");
		prewarm = { startupMs: ready?.startup_ms, readyBeforeFirstCall: Boolean(ready && firstCall && ready.mono_ms < firstCall.mono_ms) };
		if (!ready?.prewarmed || events.filter(event => event.type === "runtime_created").length !== 1 || events.some(event => event.type === "code_end" && event.metrics.python_pid !== ready.python_pid)) throw new Error("Prewarmed process was not reused");
	}
	console.log(JSON.stringify({ app, rows, declarations: { toolTokens: server.requests[0].tools?.length ? countTokens(declarations) : 0, codeActPromptTokens: countTokens(codeActPrompt) }, modelRequests: server.requests.length, toolTurns: jobs.length, telemetry, prewarm, samples }));
} finally {
	await runtime?.dispose();
	await server.close();
	await disposeLsp();
}
