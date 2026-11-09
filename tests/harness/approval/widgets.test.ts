import { expect, it } from "vitest";
import { parseApprovalWidgets, validateApprovalAnswers } from "../../../src/harness/approval/widgets.ts";
it("固定组件协议拒绝未知类型、重复 ID、任意可执行动作和超限内容", () => {
	const checklist = { kind: "checklist", title: "影响确认", items: [{ id: "risk", label: "确认目标", required: true }] };
	expect(parseApprovalWidgets([checklist])).toHaveLength(1);
	for (const value of [[{ kind: "html", title: "run", html: "<script>bad</script>" }], [checklist, checklist], [{ kind: "question", id: "target", title: "选择目标", options: ["same", "same"] }], Array(7).fill({ kind: "facts", title: "too many", items: [] })]) expect(() => parseApprovalWidgets(value)).toThrow();
});
it("问题只澄清，必选勾选由宿主强制，未知或伪造表单不能批准", () => {
	const checklist = parseApprovalWidgets([{ kind: "checklist", title: "确认", items: [{ id: "risk", label: "确认本次影响", required: true }] }]);
	expect(() => validateApprovalAnswers(checklist, {}, true)).toThrow();
	expect(() => validateApprovalAnswers(checklist, { risk: true }, true)).not.toThrow();
	expect(() => validateApprovalAnswers(checklist, { risk: "true" }, true)).toThrow();
	expect(() => validateApprovalAnswers(checklist, { execute: true }, true)).toThrow();
	const question = parseApprovalWidgets([{ kind: "question", id: "target", title: "选择", options: ["保留", "调整方案"] }]);
	expect(() => validateApprovalAnswers(question, { target: "保留" }, true)).toThrow("澄清");
	expect(() => validateApprovalAnswers(question, { target: "保留" }, false)).not.toThrow();
});
