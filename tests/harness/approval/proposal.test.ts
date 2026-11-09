import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import approvalGate from "../../../src/harness/extensions/approval-gate.ts";
import { GuiDialogs } from "../../../src/gui/host/session/dialogs.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const advise = vi.hoisted(() => vi.fn());
vi.mock("../../../src/harness/approval/advisor.ts", async importOriginal => ({
	...await importOriginal<typeof import("../../../src/harness/approval/advisor.ts")>(), adviseApproval: advise,
}));
vi.mock("../../../src/harness/approval/evidence.ts", () => ({ collectApprovalEvidence: async () => [], collectBlockEvidence: async () => [] }));
const temp = useTempDir("approval-ai-");
preserveEnv("PIMOON_APPROVAL_AI_CONFIG");
const card = (decision = "ask") => ({ decision, title: "确认操作", explanation: "是否允许本次操作？",
	recommendation: decision === "allow" ? "Allow once" : "Deny", recommendationReason: "按本次范围判断", feedbackPlaceholder: "补充要求",
	actions: [{ choice: "Allow once", label: "执行本次操作" }, { choice: "Deny", label: "不执行" }] });
beforeEach(async () => {
	advise.mockReset(); advise.mockResolvedValue(card());
	process.env.PIMOON_APPROVAL_AI_CONFIG = path.join(temp.path, "approval.jsonc");
	await writeFile(process.env.PIMOON_APPROVAL_AI_CONFIG, JSON.stringify({ model: "fixture/test", routine: false }));
});
const operation = (): ToolCallEvent => ({ type: "tool_call", toolCallId: "process", toolName: "process_run", input: { argv: ["git", "status"] } });
function fixture() {
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	const audit: unknown[] = []; let leaf = "original";
	const controller = new AbortController();
	const ctx = { cwd: temp.path, mode: "gui", hasUI: true, signal: controller.signal, ui: dialogs.context(),
		sessionManager: { getSessionId: () => "session", getBranch: () => [{ type: "message", id: leaf, message: { role: "user", content: "检查项目" } }] } };
	const extension = registerExtension(pi => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }), {
		appendEntry: (_type: string, data: unknown) => audit.push(data),
	});
	const handler = extension.handlers.get("tool_call"); if (!handler) throw new Error("missing handler");
	const call = async (event = operation()) => await handler(event, ctx) as ToolCallEventResult | undefined;
	const respond = async (choice = "Allow once", feedback?: string) => {
		await vi.waitFor(() => expect(dialogs.list()).toHaveLength(1));
		const id = dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
		dialogs.respond(id, choice, feedback);
	};
	return { dialogs, audit, call, respond, cancel: () => controller.abort(), changeBranch: () => { leaf = "other"; } };
}

it("AI 是唯一裁决者，每次调用都判断，不使用旧授权匹配", async () => {
	advise.mockResolvedValue(card("allow"));
	const f = fixture(); expect(await f.call()).toBeUndefined(); expect(await f.call()).toBeUndefined();
	expect(advise).toHaveBeenCalledTimes(2); expect(f.dialogs.list()).toEqual([]);
	expect(f.audit).toMatchObject([{ actor: "advisor", decision: "approved", scope: "once" }, { actor: "advisor" }]);
});
it("AI 拒绝直接结束，不提供覆盖硬阻断的按钮", async () => {
	advise.mockResolvedValue(card("deny")); const f = fixture();
	expect(await f.call()).toMatchObject({ block: true, reason: expect.stringContaining("AI denied") });
	expect(f.dialogs.list()).toEqual([]);
});
it("AI 发起人工选择，仅批准当前操作", async () => {
	const f = fixture(), running = f.call(); await f.respond(); expect(await running).toBeUndefined();
	expect(f.audit).toMatchObject([{ actor: "user", scope: "once" }]);
	const next = f.call(); await f.respond("Deny", "不要执行"); expect(await next).toMatchObject({ block: true });
});
it("不再提供会话和永久权限", async () => {
	const f = fixture(), running = f.call();
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	const dialog = f.dialogs.list()[0]; if (!dialog) throw new Error("missing");
	expect(dialog.options).toEqual(["Allow once", "Deny", "Discuss"]);
	expect(() => f.dialogs.respond(dialog.id, "Always allow similar")).toThrow();
	await f.respond("Deny"); await running;
});
it.each(["branch", "config", "input", "cancel"] as const)("等待期间 %s 改变，迟到批准不能执行", async change => {
	const f = fixture(), event = operation(), running = f.call(event);
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	if (change === "branch") f.changeBranch();
	if (change === "config") await writeFile(process.env.PIMOON_APPROVAL_AI_CONFIG ?? "", '{"model":"fixture/changed","routine":false}');
	if (change === "input" && "argv" in event.input) event.input.argv = ["git", "reset", "--hard"];
	if (change === "cancel") f.cancel(); else await f.respond();
	expect(await running).toMatchObject({ block: true }); expect(f.dialogs.list()).toEqual([]);
});
it("澄清不是授权，即使讨论后的模型返回 allow 也继续等待人选", async () => {
	advise.mockResolvedValueOnce(card()).mockResolvedValueOnce(card("allow"));
	const f = fixture(), running = f.call(); await f.respond("Discuss", "会修改文件吗？");
	await vi.waitFor(() => expect(advise).toHaveBeenCalledTimes(2));
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1)); expect(f.audit).toEqual([]);
	expect(advise.mock.calls[1]?.[5].discussion).toContainEqual({ role: "user", content: JSON.stringify({ feedback: "会修改文件吗？", answers: {} }) });
	await f.respond(); expect(await running).toBeUndefined();
});
it("人工问题保持暂停，不转为模型替人批准", async () => {
	const f = fixture(), running = f.call();
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	expect(f.audit).toEqual([]); await f.respond(); expect(await running).toBeUndefined();
});
it("分类器故障与超时不执行、不伪装成人工拒绝或放行", async () => {
	advise.mockRejectedValueOnce(new Error("offline")); const f = fixture();
	expect(await f.call()).toMatchObject({ block: true, reason: expect.stringContaining("unavailable") });
	expect(f.dialogs.list()).toEqual([]); expect(f.audit).toMatchObject([{ actor: "host", decision: "unavailable" }]);
	await writeFile(process.env.PIMOON_APPROVAL_AI_CONFIG ?? "", '{"timeout_ms":100,"routine":false}');
	advise.mockReturnValue(new Promise(() => {}));
	expect(await f.call()).toMatchObject({ block: true, reason: expect.stringContaining("超时") });
});
it("并发人工决策串行展示，每一项单独判断；取消释放队列", async () => {
	const f = fixture(), first = f.call(), second = f.call();
	await f.respond();
	await f.respond("Deny");
	const results = await Promise.all([first, second]);
	expect(results.filter(result => result === undefined)).toHaveLength(1);
	expect(results.filter(result => result?.block)).toHaveLength(1);
	expect(advise).toHaveBeenCalledTimes(2);
});
it("读取、写入、搜索及外部工具都进入同一分类器，execute 编排器不重复审批", async () => {
	advise.mockResolvedValue(card("allow")); const f = fixture();
	for (const tool of ["read", "websearch", "mcp_send"]) expect(await f.call({ type: "tool_call", toolCallId: tool, toolName: tool, input: { path: "fixture.txt" } })).toBeUndefined();
	expect(advise).toHaveBeenCalledTimes(3);
	expect(await f.call({ type: "tool_call", toolCallId: "execute", toolName: "execute", input: { code: "print(1)" } })).toBeUndefined();
	expect(advise).toHaveBeenCalledTimes(3);
});

it("配置非法或请求无法检查时不绕过分类器直接执行", async () => {
	const f = fixture();
	await writeFile(process.env.PIMOON_APPROVAL_AI_CONFIG ?? "", '{"deny_rules":[]}');
	expect(await f.call()).toMatchObject({ block: true, reason: expect.stringContaining("configuration") });
	await writeFile(process.env.PIMOON_APPROVAL_AI_CONFIG ?? "", '{}');
	expect(await f.call({ type: "tool_call", toolName: "process_run", toolCallId: "bad", input: { argv: "not-array" } })).toMatchObject({ block: true });
	expect(advise).not.toHaveBeenCalled();
});
it("进入调用后立即修改参数也失效，检查阶段不能绑定到后来的参数", async () => {
	const f = fixture(), event = operation(), running = f.call(event);
	if ("argv" in event.input) event.input.argv = ["git", "reset", "--hard"];
	expect(await running).toMatchObject({ block: true }); expect(advise).not.toHaveBeenCalled();
});
