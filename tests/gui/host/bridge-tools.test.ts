import { expect, it, vi } from "vitest";
import { registerDelegateTools } from "../../../src/gui/host/bridge/tools.ts";
import { GuiDialogs } from "../../../src/gui/host/session/dialogs.ts";
import { registerExtension } from "../../helpers/extension.ts";

function setup() {
	const dialogs = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
	const deliver = vi.fn(async () => {});
	let active = ["execute", "read"];
	const extension = registerExtension(pi => registerDelegateTools(pi, dialogs, { deliver }), {
		getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
	});
	const tool = (name: string) => { const found = extension.registered.find(tool => tool.name === name); if (!found) throw new Error(name); return found; };
	return { dialogs, deliver, tool, ...extension, active: () => active };
}
it("ask 支持自由输入、选项、桌面抢答和取消，取消明确为未回答", async () => {
	const { dialogs, tool } = setup(), ask = tool("ask");
	let pending = ask.execute("id", { question: "需求？" }, undefined, undefined, undefined);
	const dialog = dialogs.list()[0]; if (!dialog) throw new Error("missing dialog");
	expect(dialog.kind).toBe("input"); dialogs.respond(dialog.id, "中文答案", undefined, undefined, "owner");
	expect((await pending).details).toEqual({ answered: true, answer: "中文答案" });
	const controller = new AbortController();
	pending = ask.execute("id", { question: "选择？", options: ["允许", "不允许"] }, controller.signal, undefined, undefined);
	expect(dialogs.list()[0]?.kind).toBe("select"); controller.abort();
	expect((await pending).details).toEqual({ answered: false, answer: null }); expect(dialogs.list()).toEqual([]);
	await expect(ask.execute("id", { question: "已取消" }, controller.signal, undefined, undefined)).resolves.toMatchObject({ details: { answered: false } });
});
it("deliver 等待存储成功，写入失败或预先取消不会报告交付完成", async () => {
	const { deliver, tool } = setup(), report = { summary: "done", changes: [], verification: [], unverified: [], objections: [] };
	await tool("deliver").execute("id", report, undefined, undefined, undefined); expect(deliver).toHaveBeenCalledWith(report);
	deliver.mockRejectedValueOnce(new Error("disk full"));
	await expect(tool("deliver").execute("id", report, undefined, undefined, undefined)).rejects.toThrow("disk full");
	const controller = new AbortController(); controller.abort();
	await expect(tool("deliver").execute("id", report, controller.signal, undefined, undefined)).rejects.toThrow();
	expect(deliver).toHaveBeenCalledTimes(2);
});
it("恢复工具集合后仍启用协议工具，委派提示只追加一段", () => {
	const { handlers, active } = setup();
	handlers.get("session_start")?.(); handlers.get("session_tree")?.();
	expect(active()).toEqual(["execute", "read", "ask", "deliver"]);
	const event = { systemPromptOptions: { sections: { original: "original" } } };
	handlers.get("before_agent_start")?.(event);
	expect(event.systemPromptOptions.sections).toEqual({ original: "original", delegate: expect.stringMatching(/^Delegated task:/u) });
});
