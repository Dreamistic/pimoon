import { expect, it } from "vitest";
import { GuiDialogs } from "../../../../src/gui/host/session/dialogs.ts";
import type { ApprovalRequest } from "../../../../src/harness/approval/types.ts";
import type { GuiActor } from "../../../../src/gui/host/client.ts";

const fixture = () => new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
const request: ApprovalRequest = { tool: "process_run", cwd: "fixture", detail: { argv: ["fixture"], env: {} }, units: [] };
const decision = { kind: "ask" as const, reason: "review", items: [] };
it.each(["secret", "editor"] as const)("delegate 不能应答 %s，也不能消费待答状态", async kind => {
	const dialogs = fixture(), pending = dialogs.ask(kind, "仅用户处理");
	const id = dialogs.list()[0]?.id ?? "";
	expect(() => dialogs.respond(id, "answer", undefined, undefined, "delegate")).toThrow("不允许应答");
	expect(() => dialogs.respond(id, null, undefined, undefined, "delegate")).toThrow("不允许应答");
	expect(dialogs.list()).toHaveLength(1);
	dialogs.respond(id, "owner answer");
	expect(await pending).toBe("owner answer");
});
it.each(["input", "select", "confirm"] as const)("delegate 可以应答 %s", async kind => {
	const dialogs = fixture(), pending = dialogs.ask(kind, "问题", "", ["yes"]);
	dialogs.respond(dialogs.list()[0]?.id ?? "", "yes", undefined, undefined, "delegate");
	expect(await pending).toBe("yes");
});
it("delegate 可以应答 CodeAct 确认", async () => {
	const dialogs = fixture(), pending = dialogs.confirmCodeAct({ id: "code", cwd: "fixture", code: "print(1)", reason: "执行？" });
	dialogs.respond(dialogs.list()[0]?.id ?? "", "yes", undefined, undefined, "delegate");
	expect(await pending).toEqual({ kind: "approved" });
});
it.each(["owner", "delegate"] as const)("%s 先抢答后，另一方不能再次消费同一审批", async first => {
	const dialogs = fixture(), pending = dialogs.approve(request, decision, ["Allow once", "Deny"]);
	const id = dialogs.list()[0]?.id ?? "";
	const second: GuiActor = first === "owner" ? "delegate" : "owner";
	const replies = await Promise.allSettled([first, second].map(actor => Promise.resolve().then(() => dialogs.respond(id, "Allow once", undefined, undefined, actor))));
	expect(replies.map(reply => reply.status)).toEqual(["fulfilled", "rejected"]);
	expect(await pending).toEqual({ choice: "Allow once", actor: first === "owner" ? "user" : "delegate" });
	const next = dialogs.ask("input", "后续问题");
	dialogs.respond(dialogs.list()[0]?.id ?? "", "正常"); expect(await next).toBe("正常");
});
it.each(["Allow once", "Deny", "Discuss", null])("delegate 的 %s 应答保留身份", async value => {
	const dialogs = fixture(), pending = dialogs.approve(request, decision, ["Allow once", "Deny"], { discuss: true });
	dialogs.respond(dialogs.list()[0]?.id ?? "", value, value === "Discuss" ? "解释范围" : undefined, undefined, "delegate");
	expect(await pending).toMatchObject({ choice: value ?? "cancelled", actor: "delegate" });
});
