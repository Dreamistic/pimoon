import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import approvalGate from "../../../src/harness/extensions/approval-gate.ts";
import { GuiDialogs } from "../../../src/gui/host/session/dialogs.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const advise = vi.hoisted(() => vi.fn());
const diagnostic = vi.hoisted(() => vi.fn());
vi.mock("../../../src/harness/approval/diagnostics.ts", () => ({ approvalDiagnostic: diagnostic }));
vi.mock("../../../src/harness/approval/advisor.ts", async importOriginal => ({
	...await importOriginal<typeof import("../../../src/harness/approval/advisor.ts")>(), adviseApproval: advise,
}));
const temp = useTempDir("approval-runtime-");
preserveEnv("PI_APPROVAL_GATE_CONFIG");
beforeEach(async () => {
	advise.mockReset(); diagnostic.mockReset();
	process.env.PI_APPROVAL_GATE_CONFIG = path.join(temp.path, "approval.jsonc");
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG, JSON.stringify({
		advisor: { enabled: false }, remember: { persistent_store: path.join(temp.path, "rules.jsonc") },
	}));
});
const operation = (argv = ["git", "status"], env?: Record<string, string>): ToolCallEvent => ({
	type: "tool_call", toolCallId: "process", toolName: "process_run", input: { argv, ...(env ? { env } : {}) },
});
function fixture(auditFails = false) {
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	const audit: unknown[] = [];
	let leaf = "original", session = "session";
	const controller = new AbortController();
	const ctx = { cwd: temp.path, mode: "gui", hasUI: true, signal: controller.signal, ui: dialogs.context(),
		sessionManager: { getSessionId: () => session, getBranch: () => [{ type: "message", id: leaf, message: { role: "user", content: "检查项目并验证后提交" } }] } };
	const extension = registerExtension(pi => approvalGate(pi, { mode: "gui", show: (_ui, ...args) => dialogs.approve(...args) }), {
		appendEntry: (_type: string, data: unknown) => { if (auditFails) throw new Error("audit unavailable"); audit.push(data); },
	});
	const handler = extension.handlers.get("tool_call");
	if (!handler) throw new Error("missing approval handler");
	const call = async (event = operation()) => await handler(event, ctx) as ToolCallEventResult | undefined;
	const respond = async (choice = "Allow once", feedback?: string) => {
		await vi.waitFor(() => expect(dialogs.list()).toHaveLength(1));
		const id = dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
		dialogs.respond(id, choice, feedback);
	};
	return { dialogs, audit, call, respond, registered: extension.registered,
		changeBranch: () => { leaf = "other"; }, changeSession: () => { session = "other"; },
		cancel: () => controller.abort(),
		clear: () => extension.handlers.get("before_agent_start")?.({ messageType: "user", prompt: "检查工作区" }, ctx),
		resetTree: () => extension.handlers.get("session_tree")?.({}, ctx),
		result: (event: unknown) => extension.handlers.get("tool_result")?.(event, ctx),
	};
}

it("原调用直接等待 UI；批准继续，不注册主模型审批工具或生成重试票据", async () => {
	const f = fixture();
	const running = f.call();
	await f.respond("Allow once", "只允许这一次检查");
	expect(await running).toBeUndefined();
	expect(f.registered).toEqual([]);
	expect(f.audit).toMatchObject([{ decision: "approved", scope: "once", has_feedback: true }]);
	expect(JSON.stringify(f.audit)).not.toContain("只允许这一次检查");
	const result = await f.result({ toolCallId: "process", content: [{ type: "text", text: "ok" }] });
	expect(JSON.stringify(result)).toContain("只允许这一次检查");
	expect(await f.result({ toolCallId: "process", content: [] })).toBeUndefined();
	const again = f.call(); await f.respond("Deny"); expect(await again).toMatchObject({ block: true });
});

it("会话授权严格匹配 argv、环境与工作区；同一操作不再调用顾问", async () => {
	const f = fixture(), running = f.call();
	await f.respond("Allow for session"); expect(await running).toBeUndefined();
	await f.clear(); expect(await f.call()).toBeUndefined();
	expect(advise).not.toHaveBeenCalled();
	const changed = f.call(operation(["git", "status", "--ignored"]));
	await f.respond("Deny"); expect(await changed).toMatchObject({ block: true });
	const environment = f.call(operation(["git", "status"], { FIXTURE: "different" }));
	await f.respond("Deny"); expect(await environment).toMatchObject({ block: true });
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
});

it("持久规则重建有效，外部撤销立即重新询问", async () => {
	const f = fixture(), first = f.call();
	await f.respond("Always allow similar"); expect(await first).toBeUndefined();
	expect(await fixture().call()).toBeUndefined();
	await writeFile(path.join(temp.path, "rules.jsonc"), '{"rules":[]}');
	const next = f.call(); await f.respond("Deny"); expect(await next).toMatchObject({ block: true });
});

it.each(["branch", "session", "tree", "config", "cancel", "input"] as const)("等待中 %s 改变不生成授权", async change => {
	const f = fixture(), event = operation(), running = f.call(event);
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	if (change === "branch") f.changeBranch();
	if (change === "session") f.changeSession();
	if (change === "tree") f.resetTree();
	if (change === "config") await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"remember":{"allow_persistent":false}}');
	if (change === "input" && "argv" in event.input) event.input.argv = ["git", "reset", "--hard"];
	if (change === "cancel") f.cancel();
	else if (change !== "tree") await f.respond("Always allow similar");
	expect(await running).toMatchObject({ block: true });
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
	expect(f.dialogs.list()).toEqual([]);
});

it("并发相同请求串行审批，前一会话授权让后续直接继续", async () => {
	const f = fixture(), first = f.call(), second = f.call();
	await f.respond("Allow for session");
	expect(await first).toBeUndefined(); expect(await second).toBeUndefined();
	expect(f.dialogs.list()).toEqual([]); expect(f.audit).toHaveLength(1);
});

it("并发相同请求拒绝后不再次弹出，新的用户轮次才允许再申请", async () => {
	const f = fixture(), first = f.call(), second = f.call();
	await f.respond("Deny", "先解释"); expect(await first).toMatchObject({ block: true });
	expect(await second).toMatchObject({ block: true }); expect(f.dialogs.list()).toEqual([]);
	await f.clear(); const next = f.call(); await f.respond(); expect(await next).toBeUndefined();
});

it("审计失败不撤销本次批准", async () => {
	const f = fixture(true), running = f.call();
	await f.respond(); expect(await running).toBeUndefined();
	expect(f.dialogs.notices.some(item => item.text.includes("审计"))).toBe(true);
});

it("顾问失败降为普通审批，不自动执行", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true}}');
	advise.mockRejectedValue(new Error("unavailable"));
	const f = fixture(), running = f.call();
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	expect(f.dialogs.list()[0]?.approval?.advisorUnavailable).toBe(true);
	await f.respond("Deny"); expect(await running).toMatchObject({ block: true });
});

it("顾问超时不拖住审批，取消可移除卡片", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"timeout_ms":100}}');
	advise.mockReturnValue(new Promise(() => {}));
	const f = fixture(), running = f.call();
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	expect(f.dialogs.list()[0]?.approval?.advisorUnavailable).toBe(true);
	expect(f.dialogs.list()[0]?.approval?.advisorFailure).toBe("模型响应超时");
	f.cancel(); expect(await running).toMatchObject({ block: true });
});

it("动态卡片可推荐拒绝，历史只提供已完成的决定", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true}}');
	advise.mockResolvedValue({ title: "先看看状态", explanation: "检查工作区", recommendation: "Deny",
		recommendationReason: "先解释用途", feedbackPlaceholder: "你的要求",
		actions: [{ choice: "Allow once", label: "本次检查" }, { choice: "Deny", label: "暂不检查" }] });
	const f = fixture(), first = f.call();
	await vi.waitFor(() => expect(f.dialogs.list()[0]?.title).toBe("先看看状态"));
	await f.respond("Deny", "先解释用途"); expect(await first).toMatchObject({ block: true });
	await f.clear(); const second = f.call(operation(["git", "diff"]));
	await f.respond(); expect(await second).toBeUndefined();
	expect(advise.mock.calls[1]?.[5].history).toMatchObject([{ decision: "rejected", feedback: "先解释用途" }]);
});

it("卡内交流只更新说明，不执行、不保存授权；明确选择后才继续", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true}}');
	const card = { title: "检查状态", explanation: "准备查看工作区", recommendation: "Allow once",
		recommendationReason: "仅需这一次", feedbackPlaceholder: "补充要求",
		actions: [{ choice: "Allow once", label: "本次检查" }, { choice: "Deny", label: "暂不检查" }] };
	advise.mockResolvedValueOnce(card).mockResolvedValueOnce({ ...card, explanation: "不会修改项目文件，仍需明确选择。" });
	const f = fixture(), running = f.call();
	await f.respond("Discuss", "会修改文件吗？");
	await vi.waitFor(() => expect(f.dialogs.list()[0]?.approval?.reason).toContain("仍需明确选择"));
	expect(f.audit).toEqual([]);
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
	expect(advise.mock.calls[1]?.[5].discussion).toContain("User: 会修改文件吗？");
	await f.respond("Allow once"); expect(await running).toBeUndefined();
	expect(f.audit).toMatchObject([{ decision: "approved", scope: "once" }]);
});

it("交流后顾问失败回退普通审批，不把提问当成同意", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true}}');
	advise.mockResolvedValueOnce({ title: "检查", explanation: "查看状态", recommendation: "Allow once",
		recommendationReason: "仅本次", feedbackPlaceholder: "你的要求", actions: [] }).mockRejectedValueOnce(new Error("offline"));
	const f = fixture(), running = f.call();
	await f.respond("Discuss", "以后怎么办？");
	await vi.waitFor(() => expect(f.dialogs.list()[0]?.approval?.advisorUnavailable).toBe(true));
	expect(f.dialogs.list()[0]?.approval?.discuss).toBeUndefined();
	await f.respond("Deny"); expect(await running).toMatchObject({ block: true });
});

it("重建扩展后只恢复审批经验，不恢复一次许可", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true}}');
	advise.mockResolvedValue({ title: "检查", explanation: "查看状态", recommendation: "Allow once",
		recommendationReason: "仅本次", feedbackPlaceholder: "你的要求", actions: [] });
	const first = fixture(), running = first.call();
	await first.respond("Allow once"); expect(await running).toBeUndefined();
	const second = fixture(), next = second.call(operation(["git", "status", "--short"]));
	await second.respond("Deny"); expect(await next).toMatchObject({ block: true });
	expect(advise.mock.calls[1]?.[5].history).toMatchObject([{ decision: "approved", scope: "once", sameFamily: true, count: 1 }]);
});

it("自主模式明确放行只批准本次，不弹卡、不保存长期规则或人工批准经验", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":true}}');
	advise.mockResolvedValue({ decision: "allow", explanation: "本地检查符合任务", recommendation: "Always allow similar" });
	const f = fixture();
	expect(await f.call()).toBeUndefined(); expect(f.dialogs.list()).toEqual([]);
	expect(f.audit).toMatchObject([{ actor: "advisor", decision: "approved", scope: "once" }]);
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
	await expect(readFile(path.join(temp.path, "rules.jsonc.experiences.json"))).rejects.toThrow();
	expect(await f.call()).toBeUndefined(); expect(advise).toHaveBeenCalledTimes(2);
});

it("人在时拿不准才显示人工卡片，自主关闭时即使模型allow仍等待人", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":true}}');
	advise.mockResolvedValue({ decision: "ask", title: "选择目标", explanation: "需要确认目标" });
	const f = fixture(), first = f.call();
	await f.respond("Deny"); expect(await first).toMatchObject({ block: true });
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":false}}');
	advise.mockResolvedValue({ decision: "allow", title: "检查", explanation: "可检查" });
	const next = f.call(); await f.respond("Allow once"); expect(await next).toBeUndefined();
});

it("离开时自主模式不等待人工；明确拒绝和模型故障不会放行", async () => {
	const { updateApprovalPresence } = await import("../../../src/harness/approval/presence.ts");
	updateApprovalPresence(900);
	try {
		await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":true}}');
		advise.mockResolvedValue({ decision: "deny", explanation: "范围不合适" });
		const f = fixture(); expect(await f.call()).toMatchObject({ block: true }); expect(f.dialogs.list()).toEqual([]);
		await f.clear(); advise.mockResolvedValue({ decision: "ask", explanation: "未知" });
		expect(await f.call()).toMatchObject({ block: true }); expect(f.dialogs.list()).toEqual([]);
		await f.clear(); advise.mockRejectedValue(new Error("offline"));
		expect(await f.call()).toMatchObject({ block: true });
		await f.clear(); advise.mockResolvedValue({ decision: "allow", explanation: "符合任务" });
		expect(await f.call()).toBeUndefined();
	} finally { updateApprovalPresence(0); }
});

it("顾问收到近期执行证据，而不是被迫猜测测试是否跑过", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":true}}');
	advise.mockResolvedValue({ decision: "allow", explanation: "已验证的任务步骤" });
	const f = fixture();
	await f.result({ toolName: "process_run", toolCallId: "test", input: { argv: ["vitest", "run"] }, content: [{ type: "text", text: "Tests 42 passed" }], details: { exit_code: 0 }, isError: false });
	expect(await f.call()).toBeUndefined();
	expect(advise.mock.calls[0]?.[5].evidence[0]).toContain("Tests 42 passed");
});

it("等待人工期间离开，撤回卡片并让AI重新作最终决定", async () => {
	const { updateApprovalPresence } = await import("../../../src/harness/approval/presence.ts");
	updateApprovalPresence(0);
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":true}}');
	advise.mockResolvedValueOnce({ decision: "ask", title: "确认", explanation: "选择目标" })
		.mockResolvedValueOnce({ decision: "allow", explanation: "按任务限定目标继续" });
	const f = fixture(), running = f.call();
	await vi.waitFor(() => expect(f.dialogs.list()).toHaveLength(1));
	updateApprovalPresence(900);
	try {
		await expect(running).resolves.toBeUndefined();
		expect(f.dialogs.list()).toEqual([]);
		expect(advise.mock.calls[1]?.[5].presence.state).toBe("away");
		expect(f.audit).toMatchObject([{ actor: "advisor", scope: "once" }]);
	} finally { updateApprovalPresence(0); }
});

it("诊断区分自主放行、人工展示与超时，不抄录操作正文", async () => {
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":true}}');
	advise.mockResolvedValue({ decision: "allow", explanation: "private-explanation" });
	const f = fixture(); expect(await f.call(operation(["git", "status", "private-argument"]))).toBeUndefined();
	const events = diagnostic.mock.calls.map(args => args[4]);
	expect(events).toContainEqual(expect.objectContaining({ phase: "policy", autonomous: true, decision: "ask" }));
	expect(events).toContainEqual(expect.objectContaining({ phase: "advisor_start", model: expect.stringContaining("sol"), contextCount: 1 }));
	expect(events).toContainEqual(expect.objectContaining({ phase: "advisor_end", decision: "allow" }));
	expect(events).toContainEqual(expect.objectContaining({ phase: "resolved", actor: "advisor", scope: "once" }));
	expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private-explanation|private-argument/);
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG ?? "", '{"advisor":{"enabled":true,"autonomous":false,"timeout_ms":100}}');
	advise.mockReturnValue(new Promise(() => {}));
	const pending = f.call(); await f.respond("Deny"); await pending;
	expect(diagnostic.mock.calls.map(args => args[4])).toContainEqual(expect.objectContaining({ phase: "advisor_failure", reason: "timeout" }));
	expect(diagnostic.mock.calls.map(args => args[4])).toContainEqual(expect.objectContaining({ phase: "present", fallback: true }));
});
