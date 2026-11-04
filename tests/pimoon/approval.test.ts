import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import functions from "../../src/harness/extensions/codeact-functions.ts";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import memory from "../../src/harness/extensions/memory.ts";
import { MemoryStore } from "../../src/harness/memory/store.ts";
import { pimoonHome } from "../../src/pimoon/profile.ts";
import { GuiDialogs } from "../../src/gui/host/session/dialogs.ts";
import { startModelServer } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture(reply: (step: number, request: unknown) => string) {
	const base = path.resolve(".tmp/tests/approval-integration"); await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(root));
	const config = path.join(root, "approval.jsonc");
	await fs.writeFile(config, JSON.stringify({ remember: { persistent_store: path.join(root, "rules.jsonc") } }));
	vi.stubEnv("PI_APPROVAL_GATE_CONFIG", config);
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	let step = 0;
	const server = await startModelServer(request => ({ text: reply(step++, request) }));
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	try {
		const manager = SessionManager.inMemory(cwd);
		manager.appendCustomEntry("codeact_functions", ["process_run", "read", "write"]);
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "functions", factory: functions }, { name: "files", factory: fileTools },
					{ name: "approval-gate", factory: pi => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }) }, { name: "memory", factory: memory }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager });
			codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: manager });
		await runtime.session.bindExtensions({ mode: "print", uiContext: dialogs.context(), onError: ({ error }) => { throw new Error(error); } });
		return { cwd, root, runtime, server, dialogs, async close() { await runtime.session.abort(); await runtime.session.waitForIdle(); dialogs.cancel(); await runtime.dispose(); await server.close(); } };
	} catch (error) { await server.close(); throw error; }
}
const execution = (code: string) => `<execute>\n${code}\n</execute>`;
const append = `process_run(argv=${JSON.stringify([process.execPath, "-e", 'require("node:fs").appendFileSync("effect.txt","once")'])})`;
function propose(request: unknown): string {
	const id = /request_id.{0,20}?([a-f0-9]{8}-[a-f0-9-]{27})/.exec(JSON.stringify(request))?.[1];
	if (!id) throw new Error("Model did not receive an approval request id");
	return execution(`decision=approval(request_id=${JSON.stringify(id)}, reason="只在隔离目录写入测试标记", scope="once")\nassert isinstance(decision,dict)\ndecision`);
}

it("真实 CodeAct 先拦截、再提案，批准不自动执行；只重试具体调用，不重放此前副作用", async () => {
	const operation = append.replace("argv=", "timeout=1800, argv=");
	const f = await fixture((step, request) => step === 0 ? execution(`write(path="earlier.txt",content="keep")\n${operation}`)
		: step === 1 ? propose(request) : step === 2 ? execution(`${operation}\n${operation}`) : "done");
	try {
		expect(f.runtime.session.getCallableToolNames()).not.toContain("approval");
		const running = f.runtime.session.prompt("Run the isolated approval fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const dialog = f.dialogs.list()[0]; if (!dialog?.approval) throw new Error("missing proposal");
		expect(f.server.requests).toHaveLength(2); expect(dialog.kind).toBe("approval");
		expect(f.runtime.session.getCallableToolNames()).toContain("approval");
		expect(JSON.stringify(f.server.requests[0])).toContain("Present a blocked request");
		expect(JSON.stringify(f.server.requests[1])).toContain("Present a blocked request");
		expect(await fs.readFile(path.join(f.cwd, "earlier.txt"), "utf8")).toBe("keep");
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		f.dialogs.respond(dialog.id, "Allow once", "仅本次，不代表今后允许");
		await running;
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		expect(await fs.readFile(path.join(f.cwd, "earlier.txt"), "utf8")).toBe("keep");
		expect(f.server.requests).toHaveLength(4);
		expect(JSON.stringify(f.server.requests[2])).toContain("仅本次，不代表今后允许");
		expect(JSON.stringify(f.server.requests[3])).toContain("approval_required");
		expect(f.dialogs.list()).toEqual([]);
	} finally { await f.close(); }
});

it("旧会话批量检查 Git、ADB 和 APK 后仍能发现审批入口并提交提案", async () => {
	const jobs = [{ argv: ["git", "status", "--short", "--branch"] }, { argv: ["adb", "devices", "-l"] },
		{ argv: ["rg", "--files", "--hidden", "-g", "*.apk", "-g", "!node_modules", "-g", "!.git"] }];
	const f = await fixture((step, request) => step === 0 ? execution(`results=batch("process_run",${JSON.stringify(jobs)})\nfor i,row in enumerate(results):\n    print(i,row)`)
		: step === 1 ? propose(request) : "done");
	try {
		const running = f.runtime.session.prompt("Check the fixture commands; request approval when blocked.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const request = JSON.stringify(f.server.requests[1]);
		expect(request).toContain("Present a blocked request");
		expect(new Set([...request.matchAll(/request_id.{0,20}?([a-f0-9]{8}-[a-f0-9-]{27})/g)].map(match => match[1])).size).toBe(3);
		expect(request).toContain("Next block: approval");
		const dialog = f.dialogs.list()[0]; if (!dialog) throw new Error("missing batch proposal");
		f.dialogs.respond(dialog.id, "Deny", "这是隔离回归，不运行外部程序");
		await running;
		expect(f.server.requests).toHaveLength(3);
		expect(JSON.stringify(f.server.requests[2])).toContain("这是隔离回归，不运行外部程序");
	} finally { await f.close(); }
});

it("拒绝意见进入下一次模型请求，AI 可按真实范围自主沉淀记忆，不产生授权", async () => {
	let destination = "";
	const lesson = "---\nname: 审批反馈示例\ndescription: 修改隔离项目配置前读取\ntype: feedback\n---\n用户拒绝本次写入，要求先提供方案。不是永久禁令或执行许可。\n";
	const f = await fixture((step, request) => step === 0 ? execution(append) : step === 1 ? propose(request)
		: step === 2 ? execution(`write(path=${JSON.stringify(destination)},content=${JSON.stringify(lesson)})`) : "done");
	try {
		const scope = (await new MemoryStore(path.join(pimoonHome, "memory")).scopes(f.cwd)).find(scope => scope.kind === "project");
		if (!scope) throw new Error("missing memory scope");
		destination = path.join(scope.directory, "entries/approval-feedback.md");
		const running = f.runtime.session.prompt("Exercise rejection feedback in the isolated fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		await expect(fs.access(destination)).rejects.toThrow();
		const dialog = f.dialogs.list()[0]; if (!dialog) throw new Error("missing proposal");
		f.dialogs.respond(dialog.id, "Deny", "先提供方案，本次不要写入");
		await running;
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		expect(JSON.stringify(f.server.requests[2])).toContain("先提供方案，本次不要写入");
		expect(await fs.readFile(destination, "utf8")).toBe(lesson);
		expect(await fs.readFile(path.join(scope.directory, "MEMORY.md"), "utf8")).toContain("审批反馈示例");
		await expect(fs.access(path.join(f.root, "rules.jsonc"))).rejects.toThrow();
	} finally { await f.close(); }
});

it("停止等待会立即撤销 UI；迟到的批准不能执行或生成记忆", async () => {
	const f = await fixture((step, request) => step === 0 ? execution(append) : step === 1 ? propose(request) : "done");
	try {
		const running = f.runtime.session.prompt("Wait for approval in the isolated fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing proposal");
		await f.runtime.session.abort(); await running;
		expect(f.dialogs.list()).toEqual([]);
		expect(() => f.dialogs.respond(id, "Allow once")).toThrow();
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		await expect(fs.access(path.join(f.root, "rules.jsonc"))).rejects.toThrow();
	} finally { await f.close(); }
});
