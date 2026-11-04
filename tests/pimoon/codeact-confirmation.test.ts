import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import type { ConfirmCodeAct } from "../../src/pimoon/codeact/confirmation.ts";
import { isCodeActResultMessage, type CodeActMessage } from "../../src/pimoon/codeact/types.ts";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { GuiDialogs } from "../../src/gui/host/session/dialogs.ts";
import { GuiLiveTools } from "../../src/gui/host/projection/live-tools.ts";
import { GuiPayloads } from "../../src/gui/host/projection/payloads.ts";
import { startModelServer } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

const guarded = '<execute desc="保存标记" confirm="会新增标记文件，继续？">\nfrom pathlib import Path\nPath("marker.txt").write_text("once", encoding="utf-8")\n</execute>';
const dialogs = () => new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
afterEach(() => vi.unstubAllEnvs());

async function fixture(replies: string[], confirm?: ConfirmCodeAct, guards: InlineExtension[] = []) {
	const base = path.resolve(".tmp/tests/codeact-confirmation"); await fs.mkdir(base, { recursive: true });
	const root = await fs.mkdtemp(path.join(base, "case-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(root));
	const server = await startModelServer(() => {
		const text = replies.shift() ?? "done";
		return { text, chunks: [...text] };
	});
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const live = new GuiLiveTools(new GuiPayloads());
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct(confirm);
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
				extensionFactories: [codeact.extension, { name: "file-tools", factory: fileTools }, ...guards],
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			} });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["write"] });
			codeact.bind(result.session, event => { live.accept(event); });
			return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
		return { cwd, runtime, server, live, results: () => runtime.session.messages.filter(isCodeActResultMessage),
			async close() { await runtime.dispose(); await server.close(); } };
	} catch (error) { await server.close(); throw error; }
}

it("完整代码等待一次性确认，批准后只执行原代码；标题、调用身份和历史保留", async () => {
	const ui = dialogs();
	const value = await fixture([guarded, "done"], (request, signal) => ui.confirmCodeAct(request, signal));
	try {
		const running = value.runtime.session.prompt("Run the isolated fixture.");
		await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
		const pending = ui.list()[0]; if (!pending?.codeact) throw new Error("缺少确认");
		expect(pending.codeact).toMatchObject({ cwd: value.cwd, desc: "保存标记", reason: "会新增标记文件，继续？" });
		expect(value.live.project()[0]).toMatchObject({ toolCallId: pending.codeact.id, args: { confirmationPending: true } });
		await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
		const manager = value.runtime.session.sessionManager;
		const originalLeaf = manager.getLeafId();
		manager.appendSessionInfo("后台生成的会话名");
		if (originalLeaf) manager.appendLabelChange(originalLeaf, "fixture bookmark");
		ui.respond(pending.id, "yes");
		expect(() => ui.respond(pending.id, "yes")).toThrow("已结束");
		await running;
		expect(await fs.readFile(path.join(value.cwd, "marker.txt"), "utf8")).toBe("once");
		expect(value.results()).toHaveLength(1);
		expect(value.results()[0]?.details).toMatchObject({ id: pending.codeact.id, isError: false, metrics: { outcome: "success" } });
		expect(value.live.project()[0]).toMatchObject({ args: { desc: "保存标记" }, completion: { isError: false } });
		expect(value.live.project()[0]?.args).not.toHaveProperty("confirmationPending");
		const assistant: CodeActMessage | undefined = value.runtime.session.messages.find(message => message.role === "assistant");
		expect(assistant?.codeact).toMatchObject({ id: pending.codeact.id, desc: "保存标记", confirm: "会新增标记文件，继续？" });
		expect(ui.list()).toEqual([]);
		expect(value.server.requests).toHaveLength(2);
	} finally { await value.close(); }
});

it("拒绝保留用户意见，零执行耗时且不借用上块结果，不损失 Python 变量", async () => {
	const ui = dialogs();
	const replies = ['<execute>\nsentinel=42\nsentinel\n</execute>', "done", guarded, "done", '<execute>\nassert sentinel==42\nsentinel\n</execute>', "done"];
	const value = await fixture(replies, (request, signal) => ui.confirmCodeAct(request, signal));
	try {
		await value.runtime.session.prompt("Initialize fixture.");
		const running = value.runtime.session.prompt("Request the fixture change.");
		await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
		const pending = ui.list()[0]; if (!pending) throw new Error("缺少确认");
		ui.respond(pending.id, "no", "不要写文件，先给出方案");
		await running;
		expect(value.results().at(-1)?.details).toMatchObject({ isError: true, durationMs: 0, metrics: { outcome: "confirmation_rejected", executed: false }, nestedCalls: { calls: [] } });
		expect(value.results().at(-1)?.details.metrics).not.toHaveProperty("python_ms");
		expect(JSON.stringify(value.results().at(-1)?.content)).toContain("不要写文件，先给出方案");
		expect(JSON.stringify(value.server.requests.at(-1))).toContain("Code did not run");
		await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
		await value.runtime.session.prompt("Verify the retained state without replaying changes.");
		expect(value.results().at(-1)?.details.isError).toBe(false);
	} finally { await value.close(); }
});

it("等待确认期间取消，不运行代码、不接受迟到批准", async () => {
	const ui = dialogs();
	const value = await fixture([guarded], (request, signal) => ui.confirmCodeAct(request, signal));
	try {
		const running = value.runtime.session.prompt("Request a fixture change.");
		await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
		const id = ui.list()[0]?.id ?? "";
		await value.runtime.session.abort(); await running;
		expect(ui.list()).toEqual([]);
		expect(() => ui.respond(id, "yes")).toThrow("已结束");
		await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
		expect(value.results().at(-1)?.details).toMatchObject({ durationMs: 0, metrics: { outcome: "cancelled", executed: false } });
		expect(value.server.requests).toHaveLength(1);
	} finally { await value.close(); }
});

it("无交互入口不批准 confirm，记录未执行且不回落到原生工具", async () => {
	const value = await fixture([guarded, "done"]);
	try {
		await value.runtime.session.prompt("Non-interactive fixture.");
		await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
		expect(value.results()[0]?.details).toMatchObject({ durationMs: 0, metrics: { outcome: "confirmation_unavailable", executed: false } });
		expect(value.runtime.session.messages.some(message => message.role === "toolResult")).toBe(false);
	} finally { await value.close(); }
});

it("历史叶节点变化使旧确认失效，不在新上下文执行原代码", async () => {
	const ui = dialogs();
	const value = await fixture([guarded, "done"], (request, signal) => ui.confirmCodeAct(request, signal));
	try {
		const running = value.runtime.session.prompt("Request the fixture change.");
		await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
		value.runtime.session.sessionManager.appendCustomEntry("fixture-context-change", {});
		ui.respond(ui.list()[0]?.id ?? "", "yes");
		await running;
		expect(value.results()[0]?.details.metrics).toMatchObject({ outcome: "confirmation_invalidated", executed: false });
		await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
	} finally { await value.close(); }
});

it("批准整块后仍经过 SDK 工具审批，拒绝的写入不执行", async () => {
	const guard: InlineExtension = { name: "fixture-approval", factory(pi) {
		pi.on("tool_call", event => event.toolName === "write" ? { block: true, reason: "fixture policy denied the write" } : undefined);
	} };
	const ui = dialogs();
	const value = await fixture(['<execute desc="写入标记" confirm="继续？">\nwrite(path="marker.txt",content="bad")\n</execute>', "done"],
		(request, signal) => ui.confirmCodeAct(request, signal), [guard]);
	try {
		const running = value.runtime.session.prompt("Confirm then apply the tool policy.");
		await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
		ui.respond(ui.list()[0]?.id ?? "", "yes"); await running;
		await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
		expect(value.results()[0]?.details.isError).toBe(true);
		expect(JSON.stringify(value.results()[0]?.content)).toContain("fixture policy denied");
	} finally { await value.close(); }
});
