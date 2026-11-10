import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { GuiClient } from "../../../../src/gui/host/client.ts";

export function delegateTests(fixture: () => { host: GuiClient; agentDir: string }) {
	it("delegate 按会话 ID 发消息和应答，owner 同时看见审批且保持控制权", async () => {
		const { host: owner, agentDir } = fixture();
		await writeFile(path.join(agentDir, "configs", "approval-ai.jsonc"), '{"model":"gui-fixture/test","routine":false}');
		const session = owner.selected; if (!session) throw new Error("missing session");
		const delegate = owner.host.createClient(undefined, "delegate");
		expect(delegate.selected).toBeUndefined();
		await owner.dispatch({ action: "observe", visible: false });
		expect(session.observed).toBe(false);
		await owner.dispatch({ action: "observe", visible: true });
		const running = delegate.dispatch({ action: "prompt", text: "检查 input.txt 并写入 output.txt", images: [], behavior: "followUp" }, session.id);
		try {
			await vi.waitFor(() => expect(owner.execution.dialogs.list()).toHaveLength(1), { timeout: 10000 });
			const dialog = owner.execution.dialogs.list()[0]; if (!dialog) throw new Error("missing approval");
			expect(dialog.kind).toBe("approval");
			await delegate.dispatch({ action: "dialog", id: dialog.id, value: "Allow once" }, session.id);
			await expect(owner.dispatch({ action: "dialog", id: dialog.id, value: "Deny" }, session.id)).rejects.toThrow("对话框已结束");
			await running;
			expect(owner.runtime.session.sessionManager.getEntries()).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "custom", customType: "approval_decision", data: expect.objectContaining({ actor: "delegate", decision: "approved" }) }),
			]));
			expect(owner.execution.snapshot().entries.flatMap(entry => entry.messages)).toEqual(expect.arrayContaining([
				expect.objectContaining({ role: "custom", customType: "approval_decision", content: "审批: 委派代理 / 已批准" }),
			]));
			const answer = owner.execution.dialogs.ask("input", "补充需求");
			const id = owner.execution.dialogs.list()[0]?.id ?? "";
			await delegate.dispatch({ action: "abort" }, session.id);
			expect(await answer).toBeUndefined();
			await expect(delegate.dispatch({ action: "dialog", id, value: "迟到" }, session.id)).rejects.toThrow("对话框已结束");
		} finally {
			await owner.dispatch({ action: "abort" }, session.id);
			await running; delegate.close();
		}
	});
}
