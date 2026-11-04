import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import approvalGate from "../../../src/harness/extensions/approval-gate.ts";
import { GuiDialogs } from "../../../src/gui/host/session/dialogs.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("approval-proposal-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");
beforeEach(async () => {
	process.env.PI_APPROVAL_GATE_CONFIG = path.join(temp.path, "approval.jsonc");
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG, JSON.stringify({ remember: { persistent_store: path.join(temp.path, "rules.jsonc") } }));
});
const processCall = (argv = ["git", "status"], env?: Record<string, string>): ToolCallEvent => ({ type: "tool_call", toolCallId: "process", toolName: "process_run", input: { argv, ...(env ? { env } : {}) } });

function fixture(auditFails = false) {
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	const audit: unknown[] = [];
	let leaf = "original", session = "session";
	let active = ["read", "process_run"], excluded = false;
	const ctx = { cwd: temp.path, mode: "gui", hasUI: true, ui: dialogs.context(),
		sessionManager: { getSessionId: () => session, getBranch: () => [{ type: "message", id: leaf }] } };
	const extension = registerExtension(pi => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }), { getActiveTools: () => active, setActiveTools: (names: string[]) => { active = excluded ? names.filter(name => name !== "approval") : names; },
		appendEntry: (_type: string, data: unknown) => { if (auditFails) throw new Error("audit unavailable"); audit.push(data); } });
	const tool = extension.registered.find(tool => tool.name === "approval");
	const handler = extension.handlers.get("tool_call");
	if (!tool || !handler) throw new Error("missing approval extension");
	const call = async (event: ToolCallEvent) => await handler(event, ctx) as ToolCallEventResult | undefined;
	const defer = async (event: ToolCallEvent) => {
		const blocked = await call(event); expect(blocked?.block).toBe(true); expect(dialogs.list()).toEqual([]);
		const value: unknown = JSON.parse(blocked?.reason ?? "null");
		if (!value || typeof value !== "object" || !("request_id" in value) || typeof value.request_id !== "string") throw new Error("missing request id");
		return value.request_id;
	};
	const propose = (id: string, scope = "once", signal?: AbortSignal) => tool.execute("proposal", { request_id: id, scope, reason: "检查项目状态" }, signal, undefined, ctx);
	const respond = async (choice = "Allow once", feedback?: string) => {
		await vi.waitFor(() => expect(dialogs.list()).toHaveLength(1));
		const id = dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
		dialogs.respond(id, choice, feedback);
	};
	return { dialogs, audit, call, defer, propose, respond, active: () => active, excludeApproval: () => { excluded = true; active = active.filter(name => name !== "approval"); }, changeBranch: () => { leaf = "other"; }, changeSession: () => { session = "other"; },
		clear: () => extension.handlers.get("before_agent_start")?.({}, ctx), resetTree: () => extension.handlers.get("session_tree")?.({}, ctx) };
}

it("旧函数列表按需获得审批入口，短结果保留续接信息而不复制完整命令", async () => {
	const f = fixture();
	expect(f.active()).not.toContain("approval");
	const blocked = await f.call(processCall(["program", "large-payload".repeat(500)]));
	expect(f.active()).toEqual(["read", "process_run", "approval"]);
	expect(blocked?.reason?.length).toBeLessThan(600);
	expect(blocked?.reason).toContain("Next block: approval");
	expect(blocked?.reason).not.toContain("large-payload");
	expect(f.dialogs.list()).toEqual([]);
});

it("模型请求前补齐审批入口，不改变实际操作选择", async () => {
	const f = fixture();
	await f.clear();
	expect(f.active()).toEqual(["read", "process_run", "approval"]);
	expect(f.dialogs.list()).toEqual([]);
});

it("明确的工具注册排除仍生效，不输出无法调用的审批指令", async () => {
	const f = fixture(); f.excludeApproval(); await f.clear();
	expect((await f.call(processCall()))?.reason).toContain("Approval entry is excluded");
	expect(f.active()).not.toContain("approval");
	expect(f.dialogs.list()).toEqual([]);
});

it("宿主裁剪超时不会使一次票据失配，改变 argv 仍需重新审批", async () => {
	const f = fixture(), operation = processCall();
	const id = await f.defer({ ...operation, input: { ...operation.input, timeout: 1790 } });
	const proposed = f.propose(id); await f.respond(); await proposed;
	expect(await f.call(processCall(["git", "reset", "--hard"]))).toMatchObject({ block: true });
	expect(await f.call({ ...operation, input: { ...operation.input, timeout: 1780 } })).toBeUndefined();
	expect(await f.call(operation)).toMatchObject({ block: true });
});

it("审查只返回 ID，AI 提案后才显示审批；一次票据严格绑定参数且只能消费一次", async () => {
	const f = fixture(), operation = processCall();
	const id = await f.defer(operation);
	const proposed = f.propose(id, "session"); await f.respond("Allow once", "只允许这一次检查");
	expect((await proposed).structuredContent).toMatchObject({ status: "approved", decision: "approved", scope: "once", feedback: "只允许这一次检查" });
	expect((await f.propose(id)).structuredContent).toMatchObject({ status: "unavailable" });
	expect(await f.call(processCall(["git", "reset", "--hard"]))).toMatchObject({ block: true });
	expect(await f.call(operation)).toBeUndefined();
	expect(await f.defer(operation)).not.toBe(id);
	expect(f.audit).toMatchObject([{ decision: "approved", scope: "once", has_feedback: true }]);
	expect(JSON.stringify(f.audit)).not.toContain("只允许这一次检查");
});

it("会话授权不扩大 argv、env 或工作区，也不会落盘或跨会话传播", async () => {
	const f = fixture(), operation = processCall();
	const id = await f.defer(operation), proposed = f.propose(id); await f.respond("Allow for session");
	expect((await proposed).structuredContent).toMatchObject({ scope: "session" });
	await f.clear(); expect(await f.call(operation)).toBeUndefined(); expect(await f.call(operation)).toBeUndefined();
	expect(await f.call(processCall(["git", "status"], { PATH: "different" }))).toMatchObject({ block: true });
	expect(await f.call({ ...operation, input: { ...operation.input, cwd: path.join(temp.path, "other") } })).toMatchObject({ block: true });
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
	expect(await fixture().call(operation)).toMatchObject({ block: true });
});

it("持久范围显示精确规则，重建实例有效，外部撤销及明确拒绝仍生效", async () => {
	const f = fixture(), operation = processCall();
	const id = await f.defer(operation), proposed = f.propose(id, "persistent"); await f.respond("Always allow similar");
	expect((await proposed).structuredContent).toMatchObject({ scope: "persistent" });
	expect(await fixture().call(operation)).toBeUndefined();
	expect(await fixture().call(processCall(["git", "status", "--ignored"]))).toMatchObject({ block: true });
	const saved = await readFile(path.join(temp.path, "rules.jsonc"), "utf8");
	await writeFile(path.join(temp.path, "rules.jsonc"), '{"rules":[]}');
	expect(await f.call(operation)).toMatchObject({ block: true });
	const config = JSON.parse(await readFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", "utf8")) as { deny_rules?: unknown[] };
	await writeFile(path.join(temp.path, "rules.jsonc"), saved);
	config.deny_rules = [{ name: "deny-process", tools: ["process_run"], reason: "test deny" }];
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", JSON.stringify(config));
	expect((await fixture().call(operation))?.reason).toContain("Deny rule");
});

it("带环境覆盖不提供持久范围；错误建议可以更正，不产生授权", async () => {
	const f = fixture(), operation = processCall(["git", "status"], { FIXTURE: "value" });
	const id = await f.defer(operation);
	expect((await f.propose(id, "persistent")).structuredContent).toMatchObject({ status: "invalid_scope" });
	expect(f.dialogs.list()).toEqual([]);
	const proposed = f.propose(id, "once"); await f.respond();
	expect((await proposed).structuredContent).toMatchObject({ scope: "once" });
});

it.each(["branch", "session", "tree", "config", "cancel"] as const)("等待中 %s 变化，不保存授权且迟到响应不能补发", async change => {
	const f = fixture(), operation = processCall(), controller = new AbortController();
	const id = await f.defer(operation), proposed = f.propose(id, "persistent", controller.signal);
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	if (change === "branch") f.changeBranch();
	if (change === "session") f.changeSession();
	if (change === "tree") f.resetTree();
	if (change === "config") await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"remember":{"allow_persistent":false}}');
	if (change === "cancel") controller.abort();
	else await f.respond("Always allow similar");
	expect((await proposed).structuredContent).toMatchObject({ status: "blocked", decision: "cancelled" });
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
	expect((await f.propose(id)).structuredContent).toMatchObject({ status: "unavailable" });
});

it("同一 ID 并发提案仅产生一次 UI，拒绝后当前任务不能反复申请", async () => {
	const f = fixture(), operation = processCall(), id = await f.defer(operation);
	const proposed = f.propose(id);
	expect((await f.propose(id)).structuredContent).toMatchObject({ status: "unavailable" });
	await f.respond("Deny", "先解释，不要运行");
	expect((await proposed).structuredContent).toMatchObject({ status: "blocked", decision: "rejected", feedback: "先解释，不要运行" });
	expect((await f.call(operation))?.reason).toContain("new user instruction"); expect(f.dialogs.list()).toEqual([]);
	await f.clear(); expect(await f.defer(operation)).not.toBe(id);
});

it("审计记录失败不撤销或伪造已经生效的一次授权", async () => {
	const f = fixture(true), operation = processCall(), id = await f.defer(operation);
	const proposed = f.propose(id); await f.respond();
	expect((await proposed).structuredContent).toMatchObject({ status: "approved", scope: "once", audit_pending: true });
	expect(await f.call(operation)).toBeUndefined();
	expect(await f.call(operation)).toMatchObject({ block: true });
});

it("过期待审批 ID 不生成 UI 或许可", async () => {
	const f = fixture(), id = await f.defer(processCall());
	vi.useFakeTimers();
	try {
		vi.setSystemTime(Date.now() + 31 * 60_000);
		expect((await f.propose(id)).structuredContent).toMatchObject({ status: "unavailable" });
		expect(f.dialogs.list()).toEqual([]);
	} finally { vi.useRealTimers(); }
});

it("配置改变后旧一次票据失效；未知 ID、恢复历史都不能生成授权", async () => {
	const f = fixture(), operation = processCall(), id = await f.defer(operation);
	const proposed = f.propose(id); await f.respond(); await proposed;
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"remember":{"allow_persistent":false}}');
	expect(await f.call(operation)).toMatchObject({ block: true });
	expect((await f.propose("model-invented-id")).structuredContent).toMatchObject({ status: "unavailable" });
	f.resetTree(); expect((await f.propose(id)).structuredContent).toMatchObject({ status: "unavailable" });
});
