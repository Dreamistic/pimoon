import { expect, it } from "vitest";
import { GuiDialogs } from "../../../../src/gui/host/session/dialogs.ts";

const request = { id: "execution-a", cwd: "D:/workspace", desc: "检查配置", reason: "允许修改？", code: 'print("confirm is not permission")' };
const dialogs = () => new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });

it("确认只消费一次，拒绝意见不能被误当批准选项", async () => {
	const ui = dialogs();
	const pending = ui.confirmCodeAct(request);
	const item = ui.list()[0]; if (!item) throw new Error("缺少请求");
	expect(item).toMatchObject({ kind: "codeact", codeact: request });
	expect(() => ui.respond(item.id, "yes", "不允许附在批准上")).toThrow("无效拒绝意见");
	expect(() => ui.respond(item.id, "maybe")).toThrow("无效执行确认");
	expect(() => ui.respond(item.id, "no", "x".repeat(2001))).toThrow("无效拒绝意见");
	ui.respond(item.id, "no", " yes ");
	expect(await pending).toEqual({ kind: "rejected", feedback: "yes" });
	expect(ui.list()).toEqual([]);
	expect(() => ui.respond(item.id, "yes")).toThrow("已结束");
});

it("取消立即结束等待，迟到响应和重新读取列表不能重放执行", async () => {
	const ui = dialogs(), controller = new AbortController();
	const pending = ui.confirmCodeAct(request, controller.signal);
	const id = ui.list()[0]?.id ?? "";
	expect(ui.list()[0]?.id).toBe(id);
	controller.abort();
	expect(await pending).toEqual({ kind: "cancelled" });
	expect(ui.list()).toEqual([]);
	expect(() => ui.respond(id, "yes")).toThrow("已结束");
});

it("已经取消和会话销毁不留下待处理请求，也不自动批准", async () => {
	const ui = dialogs(), controller = new AbortController(); controller.abort();
	expect(await ui.confirmCodeAct(request, controller.signal)).toEqual({ kind: "cancelled" });
	const pending = ui.confirmCodeAct(request);
	ui.cancel();
	expect(await pending).toEqual({ kind: "cancelled" });
	expect(ui.list()).toEqual([]);
});

it("会话各自持有确认，其他会话不能消费请求；普通对话框不接收拒绝意见", async () => {
	const first = dialogs(), second = dialogs();
	const pending = first.confirmCodeAct(request);
	const id = first.list()[0]?.id ?? "";
	expect(() => second.respond(id, "yes")).toThrow("已结束");
	first.respond(id, "yes"); expect(await pending).toEqual({ kind: "approved" });
	const simple = first.ask("confirm", "普通确认");
	const simpleId = first.list()[0]?.id ?? "";
	expect(() => first.respond(simpleId, null, "instruction")).toThrow("无效拒绝意见");
	first.respond(simpleId, "yes"); expect(await simple).toBe("yes");
});
