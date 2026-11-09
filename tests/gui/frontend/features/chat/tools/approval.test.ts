import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "../../../../../../src/harness/approval/types.ts";
import { GuiDialogs } from "../../../../../../src/gui/host/session/dialogs.ts";
import { ApprovalBar } from "../../../../../../src/gui/frontend/features/chat/tools/approval.tsx";
import { renderWithMemory } from "../../../../helpers/render.ts";

const request: ApprovalRequest = { tool: "process_run", cwd: "D:/fixture/中文", detail: { argv: ["git", "status"], env: {} },
	units: [{ action: "execute", target: { kind: "command", value: '{"argv":["git","status"],"env":{}}' } }] };
const decision: Extract<ApprovalDecision, { kind: "ask" }> = { kind: "ask", reason: "default process_run approval policy", items: request.units.map(unit => ({ unit, reason: "default process_run approval policy" })) };
const ui = () => new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
const options = ["Allow once", "Deny"] as const;

describe("统一审批条", () => {
	it("实际操作与 AI 说明分离，范围由后端生成且响应只消费一次", async () => {
		const dialogs = ui();
		const pending = dialogs.approve(request, decision, options, { card: { title: "检查工作区状态", explanation: "检查状态，不修改文件", recommendation: "Allow once",
				recommendationReason: "本任务需要重复检查", feedbackPlaceholder: "补充本次要求",
				actions: [{ choice: "Allow once", label: "只检查这次" },
					{ choice: "Deny", label: "先不检查" }] } });
		const dialog = dialogs.list()[0]; if (!dialog) throw new Error("missing approval");
		expect(dialog.kind).toBe("approval"); expect(dialog.title).toBe("检查工作区状态");
		expect(dialog.approval?.content.map(line => line.text).join("\n")).toContain('["git","status"]');
		expect(dialog.approval?.recommended).toBe("once");
		expect(dialog.approval?.scopes.map(scope => scope.scope)).toEqual(["once"]);
		expect(() => dialogs.respond(dialog.id, "yes")).toThrow();
		dialogs.respond(dialog.id, "Allow once", "  本次可以检查状态  ");
		expect(await pending).toEqual({ choice: "Allow once", feedback: "本次可以检查状态" });
		expect(() => dialogs.respond(dialog.id, "Allow once")).toThrow();
	});
	it("所有工具使用相同结构，不出现旧选择弹窗；Unicode 保留，控制序列清理", async () => {
		const dialogs = ui();
		const pending = dialogs.approve({ ...request, tool: "process_run", detail: { argv: ["程序", "\u001b[31m中文🧪\u001b[0m\nSensitive units:"], env: {} } }, decision, ["Allow once", "Deny"],
			{ card: { title: "操作审批", explanation: "<script>not html</script> 中文🧪", recommendation: "Deny",
				recommendationReason: "未知程序", feedbackPlaceholder: "补充意见", actions: [{ choice: "Allow once", label: "仅运行这次" }, { choice: "Deny", label: "暂不运行" }] } });
		const dialog = dialogs.list()[0]; if (!dialog) throw new Error("missing approval");
		const doc = parseHTML(renderWithMemory(createElement(ApprovalBar, { dialog, disabled: false, send: async () => true }))).document;
		expect(doc.querySelector(".approval-bar-reason")?.textContent).toContain("<script>not html</script>");
		expect(doc.querySelector("script,[role=dialog]")).toBeNull();
		expect(doc.querySelectorAll('input[type="radio"]')).toHaveLength(1);
		expect(doc.querySelector(".approval-bar")?.textContent).toContain("此操作尚未执行");
		expect(dialog.approval?.recommended).toBeNull();
		expect(doc.querySelectorAll('input[type="radio"][checked]')).toHaveLength(0);
		expect(doc.querySelector(".approval-bar-range")?.textContent).toContain("AI建议拒绝");
		const buttons = [...doc.querySelectorAll("button")];
		expect(buttons.find(button => button.textContent?.includes("选择范围后仍要执行"))?.hasAttribute("disabled")).toBe(true);
		expect(buttons.find(button => button.textContent?.includes("AI推荐"))?.textContent).toContain("拒绝");
		expect(() => dialogs.respond(dialog.id, "Always allow similar")).toThrow();
		dialogs.respond(dialog.id, "Deny", "使用只读工具");
		expect(await pending).toEqual({ choice: "Deny", feedback: "使用只读工具" });
	});
	it("关闭、超时及取消不会批准，迟到响应不能重放", async () => {
		vi.useFakeTimers();
		try {
			const dialogs = ui();
			const pending = dialogs.approve(request, decision, options, { timeout: 100 });
			const id = dialogs.list()[0]?.id; if (!id) throw new Error("missing approval");
			await vi.advanceTimersByTimeAsync(100);
			expect(await pending).toBeUndefined(); expect(dialogs.list()).toEqual([]);
			expect(() => dialogs.respond(id, "Allow once")).toThrow();
			const controller = new AbortController();
			const next = dialogs.approve(request, decision, options, { signal: controller.signal });
			controller.abort(); expect(await next).toBeUndefined(); expect(dialogs.list()).toEqual([]);
		} finally { vi.useRealTimers(); }
	});
	it("拒绝意见单次提交，不再弹第二个输入框，长度及非法反馈由宿主校验", async () => {
		const dialogs = ui(); const pending = dialogs.approve(request, decision, options);
		const id = dialogs.list()[0]?.id; if (!id) throw new Error("missing approval");
		expect(() => dialogs.respond(id, "Deny", "x".repeat(2001))).toThrow();
		expect(() => dialogs.respond(id, null, "note")).toThrow();
		dialogs.respond(id, "Deny", "不要修改配置");
		expect(await pending).toEqual({ choice: "Deny", feedback: "不要修改配置" });
		expect(dialogs.list()).toEqual([]);
	});
});

it("卡内交流必须有文字，不消费原授权，不能在普通审批伪造交流动作", async () => {
	const dialogs = ui();
	const pending = dialogs.approve(request, decision, options, { discuss: true });
	const id = dialogs.list()[0]?.id; if (!id) throw new Error("missing dialog");
	expect(() => dialogs.respond(id, "Discuss", "  ")).toThrow();
	dialogs.respond(id, "Discuss", "会改文件吗");
	expect(await pending).toEqual({ choice: "Discuss", feedback: "会改文件吗" });
	const normal = dialogs.approve(request, decision, options);
	const normalId = dialogs.list()[0]?.id; if (!normalId) throw new Error("missing dialog");
	expect(() => dialogs.respond(normalId, "Discuss", "伪造")).toThrow();
	dialogs.respond(normalId, "Deny"); await normal;
});
