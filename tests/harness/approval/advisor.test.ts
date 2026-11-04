import { expect, it } from "vitest";
import { approvalAdvisorInput, cardChoices, parseApprovalCard } from "../../../src/harness/approval/advisor.ts";
import type { ApprovalRequest, ApprovalDecision } from "../../../src/harness/approval/types.ts";

const choices = ["Allow once", "Allow for session", "Always allow similar", "Deny"] as const;
const card = { title: "检查当前状态", explanation: "查看工作区，不修改项目文件", recommendation: "Allow once",
	recommendationReason: "这次只需查看", feedbackPlaceholder: "补充要求",
	actions: choices.map(choice => ({ choice, label: choice })) };

it("卡片只能包含已提供动作，每个恰好一次，推荐必须在其中", () => {
	expect(parseApprovalCard(JSON.stringify(card), choices).title).toBe(card.title);
	expect(cardChoices([...choices, "Deny with instruction"])).toEqual(choices);
	for (const invalid of [
		{ ...card, decision: "deny", recommendation: "Allow once" },
		{ ...card, decision: "allow", recommendation: "Deny" },
		{ ...card, recommendation: "execute" }, { ...card, decision: "auto" },
		{ ...card, actions: [...card.actions, { choice: "execute", label: "运行任意代码" }] },
		{ ...card, actions: [card.actions[0], card.actions[0], card.actions[2], card.actions[3]] },
		{ ...card, title: "x".repeat(101) }, { ...card, explanation: "" },
	]) expect(() => parseApprovalCard(JSON.stringify(invalid), choices)).toThrow();
	expect(() => parseApprovalCard("not json", choices)).toThrow();
});

it("卡片保留 Unicode 并清理终端控制字符", () => {
	const result = parseApprovalCard(JSON.stringify({ ...card, title: "\u001b[31m检查中文🧪\u001b[0m" }), choices);
	expect(result.title).toBe("检查中文🧪");
});

it("顾问只读取真实范围与已完成历史，所有输入字段都省略环境值", () => {
	const request: ApprovalRequest = { tool: "process_run", cwd: "D:/fixture", detail: { argv: ["git", "status"], env: { TOKEN: "private-value" } },
		units: [{ action: "execute", target: { kind: "command", value: '{"env":{"TOKEN":"private-value"}}', effective_value: "git status" }, remember: { session: true, persistent: false } }] };
	const decision: Extract<ApprovalDecision, { kind: "ask" }> = { kind: "ask", reason: "default", items: request.units.map(unit => ({ unit, reason: "default" })) };
	const payload = approvalAdvisorInput(request, decision, ["Allow once", "Allow for session", "Deny"], "", {
		task: "检查状态", context: ["assistant: 验证后提交"], evidence: ["Tests 42 passed"], presence: { state: "away" }, requestHash: "same", history: [{ requestHash: "same", tool: "process_run", decision: "approved", scope: "once" }],
	});
	expect(JSON.stringify(payload)).toContain('"sameRequest":true');
	expect(JSON.stringify(payload)).not.toContain("private-value");
	expect(JSON.stringify(payload)).toContain("envValues");
	expect(JSON.stringify(payload)).toContain("Tests 42 passed");
	expect(payload).toMatchObject({ presence: { state: "away" }, recentContext: ["assistant: 验证后提交"] });
});

it("文件正文不进入顾问，超长进程参数明确标为截断", () => {
	const request: ApprovalRequest = { tool: "write", cwd: "D:/fixture", detail: { path: "test.txt", content: "private-body" }, units: [] };
	const decision: Extract<ApprovalDecision, { kind: "ask" }> = { kind: "ask", reason: "default", items: [] };
	const input = { task: "", requestHash: "", history: [] };
	expect(JSON.stringify(approvalAdvisorInput(request, decision, ["Allow once", "Deny"], "", input))).not.toContain("private-body");
	const command: ApprovalRequest = { tool: "process_run", cwd: request.cwd, detail: { argv: ["program", "x".repeat(13000)], env: {} }, units: [] };
	expect(approvalAdvisorInput(command, decision, ["Allow once", "Deny"], "", input)).toMatchObject({ truncated: true });
});

it("自主决定保留在合法卡片中，拒绝任意决定字符串", () => {
	expect(parseApprovalCard(JSON.stringify({ ...card, decision: "allow" }), choices)).toMatchObject({ decision: "allow" });
	expect(parseApprovalCard(JSON.stringify({ ...card, decision: "deny", recommendation: "Deny" }), choices)).toMatchObject({ decision: "deny" });
});
