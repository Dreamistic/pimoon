import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { ModelRuntime, SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { scenarios } from "../benchmark/tool-scenarios.mjs";

const [app, bundle, home, scenarioName, modelId, thinkingLevel, transport, promptMode] = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { credential, catalog } = JSON.parse(input);
input = "";
const { fileTools, systemPrompt, CodeAct, flushTelemetry, disposeLsp,
	estimateRequestTokens, estimateResponseTokens, responseUsageStatus, summarizeTokenAccounting, textTokens } = await import(pathToFileURL(bundle).href);
const cwd = path.join(home, "workspace"), agentDir = path.join(process.env.PIMOON_HOME, "agent");
await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(agentDir, { recursive: true });
await fs.writeFile(path.join(agentDir, "models-store.json"), JSON.stringify(catalog));
await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ transport, retry: { enabled: false }, compaction: { enabled: false } }));
const scenario = scenarios[scenarioName];
await scenario.setup(cwd);
const codeAct = CodeAct ? new CodeAct() : undefined;
const factories = [{ name: "file-tools", factory: fileTools }];
if (promptMode === "runtime") factories.push({ name: "system-prompt", factory: systemPrompt });
if (codeAct) factories.unshift(codeAct.extension);
const credentials = {
	async read(provider) { return provider === "openai-codex" ? credential : undefined; },
	async list() { return [{ providerId: "openai-codex", type: "oauth" }]; },
	async modify() { throw new Error("订阅测试禁止刷新或修改凭据"); },
	async delete() { throw new Error("订阅测试禁止删除凭据"); },
};
const modelRuntime = await ModelRuntime.create({ credentials, modelsStorePath: path.join(agentDir, "models-store.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
const model = modelRuntime.getModel("openai-codex", modelId);
if (!model) throw new Error(`模型不在 pimoon 目录中: ${modelId}`);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const events = [], messages = [], requestSizes = [], toolResults = [], requestTraces = [];
const currentTrace = () => requestTraces.at(-1);
const mark = key => {
	const trace = currentTrace();
	if (trace && trace[key] === undefined) trace[key] = Math.round(performance.now() - trace.started);
};
factories.push({ name: "stream-probe", factory(pi) {
	pi.on("before_provider_request", event => {
		const payload = event.payload;
		const trace = currentTrace();
		if (trace) {
			trace.payload = { model: payload.model, effort: payload.reasoning?.effort,
				tools: (payload.tools?.length ?? 0) + (payload.input ?? []).reduce((total, item) => total + (["additional_tools", "tool_search_output"].includes(item.type) ? item.tools?.length ?? 0 : 0), 0),
				hasCodeAct: typeof payload.instructions === "string" && /<execute[ >]/u.test(payload.instructions) && payload.instructions.includes("execute_result") };
			trace.accounting.input = estimateRequestTokens(payload);
			if (payload.model !== model.id || !trace.accounting.input || trace.accounting.input.tool_definitions <= 0)
				throw new Error("模型或工具计量不完整，拒绝无效对测");
			if (codeAct ? trace.payload.tools !== 0 || !trace.payload.hasCodeAct : trace.payload.tools === 0)
				throw new Error("实际工具协议与被测应用不符，拒绝无效对测");
		}
	});
	pi.on("provider_stream_event", event => {
		mark("firstEventMs");
		const data = event.data, trace = currentTrace();
		if (typeof data !== "object" || data === null) return;
		if (data.type === "response.output_text.delta" && typeof data.delta === "string") { mark("firstTextMs"); if (trace) trace.textChars += data.delta.length; }
		if (data.type === "response.reasoning_summary_text.delta") mark("firstThinkingMs");
		if (trace && data.type === "response.output_item.added" && data.item?.type === "message") trace.textMessages++;
	});
} });
const pendingTools = new Map(), toolIntervals = [];
let rootExecutionMs = 0, modelMs = 0, returnedToolTextTokens = 0;
let requests = 0, executionErrors = 0, incompleteUsage = 0, runtime;
const started = performance.now();
let failure;
const observe = event => {
	if (event.type === "message_update" && event.assistantMessageEvent.partial.codeact) mark("codeOpenMs");
	if (event.type === "tool_execution_start" && event.toolName === "codeact") mark("executionStartMs");
	if (event.type === "message_end" && event.message.role === "assistant") mark("finishedMs");
	if (event.type === "tool_execution_start") pendingTools.set(event.toolCallId, performance.now());
	if (event.type === "tool_execution_end") {
		const started = pendingTools.get(event.toolCallId);
		const durationMs = event.durationMs ?? (started === undefined ? undefined : performance.now() - started);
		pendingTools.delete(event.toolCallId);
		if (!event.parentToolCallId) {
			rootExecutionMs += durationMs ?? 0;
			if (started !== undefined) toolIntervals.push([started, performance.now()]);
			returnedToolTextTokens += textTokens(event.result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
		}
		toolResults.push({ name: event.toolName, result: event.result });
		if (event.isError) executionErrors++;
		events.push({ type: event.type, name: event.toolName, parent: Boolean(event.parentToolCallId), isError: event.isError, durationMs });
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const message = event.message;
		const trace = currentTrace();
		if (trace && !trace.accounting.output) {
			trace.accounting.output = estimateResponseTokens(message);
			trace.accounting.usage = message.usage;
			trace.accounting.usage_status = responseUsageStatus(message);
		}
		modelMs += message.durationMs ?? 0;
		for (const key of Object.keys(usage)) usage[key] += message.usage[key] ?? 0;
		if (message.codeactStop?.usage !== undefined && message.codeactStop.usage !== "complete") incompleteUsage++;
		messages.push(message);
		if (["error", "aborted", "length"].includes(message.stopReason)) failure ??= message.errorMessage ?? message.stopReason;
	}
};
try {
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, resourceLoaderOptions: { extensionFactories: factories, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
		const extensions = services.resourceLoader.getExtensions();
		if (extensions.errors.length) throw new Error(JSON.stringify(extensions.errors));
		if (codeAct && !extensions.extensions.some(extension => extension.path === "builtin:codeact")) throw new Error("CodeAct 扩展未加载，拒绝无效对测");
		const result = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel, tools: ["read", "write", "edit", "find", "grep", "ls"] });
		const provider = result.session.agent.streamFunction;
		result.session.agent.streamFunction = (model, context, options) => {
			if (requests >= 12) throw new Error("测试请求预算 12 已用尽");
			requests++;
			requestTraces.push({ started: performance.now(), textChars: 0, textMessages: 0, accounting: {} });
			const tools = getCurrentTools(context.messages);
			requestSizes.push({ systemTokens: countTokens(JSON.stringify(context.messages.filter(message => message.role === "system"))), toolTokens: tools.length ? countTokens(JSON.stringify(tools)) : 0 });
			return provider(model, context, options);
		};
		codeAct?.bind(result.session, observe);
		return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { failure = String(error); } });
	runtime.session.subscribe(observe);
	const timeout = setTimeout(() => { failure = "测试超时 180s"; void runtime.session.abort(); }, 180_000);
	try { await runtime.session.prompt(scenario.prompt); } finally { clearTimeout(timeout); }
	if (failure) throw new Error(failure);
	await scenario.verify(cwd);
} catch (error) {
	failure ??= error instanceof Error ? error.message : String(error);
} finally {
	await runtime?.dispose();
	await flushTelemetry?.();
	await disposeLsp();
}
let toolMs = 0, right = -Infinity;
for (const [start, end] of toolIntervals.sort((a, b) => a[0] - b[0])) { toolMs += Math.max(0, end - Math.max(start, right)); right = Math.max(right, end); }
const tokenAccounting = summarizeTokenAccounting(requestTraces.map(trace => trace.accounting));
const result = { app, scenario: scenarioName, model: modelId, thinkingLevel, transport, promptMode, ok: !failure, failure, requests,
	elapsedMs: Math.round(performance.now() - started), executionErrors, incompleteUsage, modelMs, rootExecutionMs, toolMs,
	returnedToolTextTokens, tokenAccounting, usage, requestSizes, requestTraces: requestTraces.map(({ started: _started, ...trace }) => trace), events };
await fs.writeFile(path.join(home, "transcript.json"), JSON.stringify({ messages, toolResults }, null, 2));
console.log(JSON.stringify(result));
