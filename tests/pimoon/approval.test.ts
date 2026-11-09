import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import functions from "../../src/harness/extensions/codeact-functions.ts";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import { GuiDialogs } from "../../src/gui/host/session/dialogs.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
async function fixture(reply: (step: number, request: unknown) => string | ModelResponse, verdict: "ask" | "allow" | "deny" = "ask") {
	const base = path.resolve(".tmp/tests/approval-integration"); await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(root));
	const config = path.join(root, "approval.jsonc");
	await fs.writeFile(config, JSON.stringify({ model: "fixture/test" }));
	vi.stubEnv("PIMOON_APPROVAL_AI_CONFIG", config);
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	let step = 0;
	let reviews = 0;
	const server = await startModelServer(request => {
		if (JSON.stringify(request.messages[0]).includes("independent security monitor")) {
			reviews++;
			const message = request.messages.at(-1)?.content;
			const text = typeof message === "string" ? message : Array.isArray(message) ? message.map(part => part.text ?? "").join("") : "{}";
			const payload = JSON.parse(text) as { action: { tool: string } };
			const decision = payload.action.tool === "process_run" ? verdict : "allow";
			return { text: JSON.stringify({ decision, title: "本次写入测试标记", explanation: "确认仅在隔离工作区写标记。", recommendation: decision === "allow" ? "Allow once" : "Deny",
				recommendationReason: "仅本次验证", feedbackPlaceholder: "补充要求", actions: [{ choice: "Allow once", label: "本次写入" }, { choice: "Deny", label: "不写入" }] }) };
		}
		const value = reply(step++, request); return typeof value === "string" ? { text: value } : value;
	});
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
					{ name: "approval-gate", factory: pi => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }) }],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager });
			codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: manager });
		await runtime.session.bindExtensions({ mode: "print", uiContext: dialogs.context(), onError: ({ error }) => { throw new Error(error); } });
		return { cwd, root, runtime, server, dialogs, get reviews() { return reviews; }, async close() { await runtime.session.abort(); await runtime.session.waitForIdle(); dialogs.cancel(); await runtime.dispose(); await server.close(); } };
	} catch (error) { await server.close(); throw error; }
}
const execution = (code: string): ModelResponse => ({ tool: "execute", args: { code, desc: "审批验证" } });
const append = `subprocess.run(${JSON.stringify([process.execPath, "-e", 'require("node:fs").appendFileSync("effect.txt","once")'])},check=True)`;

it("真实 CodeAct 经 AI 判断：原调用等待，批准后继续且不重放此前副作用", async () => {
	const f = await fixture(step => step === 0 ? execution(`write(path="earlier.txt",content="keep")\n${append}\nwrite(path="later.txt",content="continued")`) : "done");
	try {
		const running = f.runtime.session.prompt("Run the isolated approval fixture.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
		const dialog = f.dialogs.list()[0]; if (!dialog?.approval) throw new Error("missing approval");
		expect(await fs.readFile(path.join(f.cwd, "earlier.txt"), "utf8")).toBe("keep");
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		f.dialogs.respond(dialog.id, "Allow once", "仅本次");
		// 后续写入也需审批；分类器只按本次 action 判断，不按历史中的 process_run 判断。
		await running;
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("once");
		expect(await fs.readFile(path.join(f.cwd, "later.txt"), "utf8")).toBe("continued");
		expect(f.reviews).toBe(3); expect(f.dialogs.list()).toEqual([]);
		expect(f.runtime.session.getCallableToolNames()).not.toContain("approval");
	} finally { await f.close(); }
}, 30000);

it("AI 放行直接执行，两次相同进程仍分别审查", async () => {
	const f = await fixture(step => step === 0 ? execution(`${append}\n${append}`) : "done", "allow");
	try {
		await f.runtime.session.prompt("Run two isolated operations.");
		expect(await fs.readFile(path.join(f.cwd, "effect.txt"), "utf8")).toBe("onceonce");
		expect(f.reviews).toBe(2); expect(f.dialogs.list()).toEqual([]);
	} finally { await f.close(); }
}, 30000);

it.each(["user", "ai"] as const)("%s 拒绝后不启动进程，拒绝原因进入主模型", async actor => {
	const f = await fixture(step => step === 0 ? execution(append) : "done", actor === "ai" ? "deny" : "ask");
	try {
		const running = f.runtime.session.prompt("Exercise isolated rejection.");
		if (actor === "user") {
			await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
			const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
			f.dialogs.respond(id, "Deny", "先提供方案");
		}
		await running; await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
		expect(JSON.stringify(f.server.requests.at(-1))).toContain(actor === "user" ? "先提供方案" : "AI denied");
		expect(f.dialogs.list()).toEqual([]);
	} finally { await f.close(); }
}, 30000);

it("停止等待立即撤销选择框，迟到批准不能执行", async () => {
	const f = await fixture(step => step === 0 ? execution(append) : "done");
	try {
		const running = f.runtime.session.prompt("Wait for human choice.");
		await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1), { timeout: 10000 });
		const id = f.dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
		await f.runtime.session.abort(); await running;
		expect(f.dialogs.list()).toEqual([]); expect(() => f.dialogs.respond(id, "Allow once")).toThrow();
		await expect(fs.access(path.join(f.cwd, "effect.txt"))).rejects.toThrow();
	} finally { await f.close(); }
}, 30000);
