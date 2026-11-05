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
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture(reply: (step: number, request: unknown) => string | ModelResponse, advisor = false) {
	const base = path.resolve(".tmp/tests/approval-integration"); await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(root));
	const config = path.join(root, "approval.jsonc");
	await fs.writeFile(config, JSON.stringify({ advisor: { enabled: advisor, model: "fixture/test" }, remember: { persistent_store: path.join(root, "rules.jsonc") } }));
	vi.stubEnv("PI_APPROVAL_GATE_CONFIG", config);
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	let step = 0;
	const server = await startModelServer(request => { const value = reply(step++, request); return typeof value === "string" ? { text: value } : value; });
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
const execution = (code: string): ModelResponse => ({ tool: "execute", args: { code, desc: "审批验证" } });
const append = `process_run(argv=${JSON.stringify([process.execPath, "-e", 'require("node:fs").appendFileSync("effect.txt","once")'])})`;
it("真实 CodeAct 在原调用等待；批准后继续后续语句，不重放此前副作用", async () => {
	const f = await fixture(step => step === 0 ? execution(`write(path="earlier.txt",content="keep")\n${append}\nwrite(path="later.txt",content="continued")`) : "done");
	try {
		const running = f.runtime.session.prompt("Run the isolated approval fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const dialog = f.dialogs.list()[0]; if (!dialog?.approval) throw new Error("missing approval");
		expect(f.server.requests).toHaveLength(1);
		expect(f.runtime.session.getCallableToolNames()).not.toContain("approval");
		expect(await fs.readFile(path.join(f.cwd, "earlier.txt"), "utf8")).toBe("keep");
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		f.dialogs.respond(dialog.id, "Allow once", "仅本次，不代表今后允许");
		await running;
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		expect(await fs.readFile(path.join(f.cwd, "later.txt"), "utf8")).toBe("continued");
		expect(f.server.requests).toHaveLength(2);
		expect(JSON.stringify(f.server.requests[1])).toContain("仅本次，不代表今后允许");
		expect(f.dialogs.list()).toEqual([]);
	} finally { await f.close(); }
});

it("批量相同调用只需一次会话授权，进程各执行一次", async () => {
	const argv = [process.execPath, "-e", 'require("node:fs").writeFileSync("batch.txt","ok")'];
	const f = await fixture(step => step === 0 ? execution(`batch("process_run",${JSON.stringify([{ argv }, { argv }])})`) : "done");
	try {
		const running = f.runtime.session.prompt("Run the isolated batch.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing approval");
		f.dialogs.respond(id, "Allow for session"); await running;
		expect(await fs.readFile(path.join(f.cwd, "batch.txt"), "utf8")).toBe("ok");
		expect(f.dialogs.list()).toEqual([]); expect(f.server.requests).toHaveLength(2);
	} finally { await f.close(); }
});

it("拒绝意见进入下一次模型请求，AI 按真实范围沉淀记忆而不产生授权", async () => {
	let destination = "";
	const lesson = "---\nname: 审批反馈示例\ndescription: 修改隔离项目配置前读取\ntype: feedback\n---\n用户拒绝本次写入，要求先提供方案。不是永久禁令或执行许可。\n";
	const f = await fixture(step => step === 0 ? execution(append)
		: step === 1 ? execution(`write(path=${JSON.stringify(destination)},content=${JSON.stringify(lesson)})`) : "done");
	try {
		const scope = (await new MemoryStore(path.join(pimoonHome, "memory")).scopes(f.cwd)).find(scope => scope.kind === "project");
		if (!scope) throw new Error("missing memory scope");
		destination = path.join(scope.directory, "entries/approval-feedback.md");
		const running = f.runtime.session.prompt("Exercise rejection feedback in the isolated fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing approval");
		f.dialogs.respond(id, "Deny", "先提供方案，本次不要写入"); await running;
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		expect(JSON.stringify(f.server.requests[1])).toContain("先提供方案，本次不要写入");
		expect(await fs.readFile(destination, "utf8")).toBe(lesson);
		await expect(fs.access(path.join(f.root, "rules.jsonc"))).rejects.toThrow();
	} finally { await f.close(); }
});

it("停止等待立即撤销卡片，迟到批准不能执行", async () => {
	const f = await fixture(step => step === 0 ? execution(append) : "done");
	try {
		const running = f.runtime.session.prompt("Wait for isolated approval.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10_000 });
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing approval");
		await f.runtime.session.abort(); await running;
		expect(f.dialogs.list()).toEqual([]);
		expect(() => f.dialogs.respond(id, "Allow once")).toThrow();
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
	} finally { await f.close(); }
});

it("辅助模型实际经过注册表调用，动态卡片返回后继续原进程且不请求主模型提案", async () => {
	const card = { title: "本次写入测试标记", explanation: "只在隔离工作区写标记；进程仍使用宿主权限。",
		recommendation: "Allow once", recommendationReason: "仅本次验证", feedbackPlaceholder: "补充要求",
		actions: [{ choice: "Allow once", label: "本次写入" }, { choice: "Allow for session", label: "本会话允许同一操作" },
			{ choice: "Always allow similar", label: "保存所示精确规则" }, { choice: "Deny", label: "不写入" }] };
	const f = await fixture(step => step === 0 ? execution(append) : step === 1 ? JSON.stringify(card) : "done", true);
	try {
		const running = f.runtime.session.prompt("验证动态审批卡。");
		await vi.waitFor(() => expect(f.dialogs.list()[0]?.title).toBe(card.title), { timeout: 10_000 });
		const dialog = f.dialogs.list()[0]; if (!dialog?.approval?.card) throw new Error("missing generated card");
		expect(f.server.requests).toHaveLength(2);
		expect(dialog.approval.card.actions[0]?.label).toBe("本次写入");
		f.dialogs.respond(dialog.id, "Allow once"); await running;
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		expect(f.server.requests).toHaveLength(3);
	} finally { await f.close(); }
});
