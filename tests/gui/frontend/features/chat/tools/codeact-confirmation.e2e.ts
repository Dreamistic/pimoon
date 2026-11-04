import { test, expect } from "@playwright/test";
import type { GuiAction } from "../../../../../../src/gui/shared/protocol/actions.ts";
import type { GuiDialog } from "../../../../../../src/gui/shared/protocol/state.ts";
import type { CodeActMessage } from "../../../../../../src/pimoon/codeact/types.ts";
import { replayTranscript } from "../../../../helpers/transcript-live-fixture.ts";
import { guiModelFixture, guiSnapshot } from "../../../../helpers/snapshot-fixture.ts";
import { assistant } from "../../../../helpers/transcript-fixtures.ts";

// SDK/Python 确认语义由集成测试覆盖；这里定向验证正式 GUI 的非模态交互和窄屏可达性。
test("执行确认不抢焦点，支持检查源码、拒绝意见与一次性提交", async ({ page }, info) => {
	const code = 'from pathlib import Path\nPath("配置.json").write_text("once", encoding="utf-8")\n';
	const message: CodeActMessage = { ...assistant([{ type: "text", text: code }], "stop"), codeact: { id: "execution-1", index: 0, complete: true, desc: "检查并更新工作区配置", confirm: "确认写入配置？" } };
	const snapshot = { ...guiSnapshot(), model: guiModelFixture(), models: [guiModelFixture()], running: true, streaming: true,
		contextEntryIds: ["user", "execution"], entries: [
			{ id: "user", parentId: null, type: "message" as const, timestamp: new Date(1).toISOString(), label: undefined, messages: [{ role: "user" as const, content: "检查配置", timestamp: 1 }] },
			{ id: "execution", parentId: "user", type: "message" as const, timestamp: new Date(100).toISOString(), label: undefined, messages: [message] },
		], liveTools: [{ toolCallId: "execution-1", toolName: "codeact", args: { code, desc: "检查并更新工作区配置", confirmationPending: true }, output: undefined }] };
	const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
	const channel = await replayTranscript(page, snapshot);
	const submitted: GuiAction[] = [];
	let release = () => {};
	await page.route("http://127.0.0.1:43177/api/action", async route => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action === "dialog") {
			submitted.push(value);
			await new Promise<void>(resolve => { release = resolve; });
		}
		await route.fulfill({ json: null });
	});
	const pending: GuiDialog = { id: "dialog-1", kind: "codeact", title: "检查并更新工作区配置", message: "确认写入配置？", initial: "", options: [], deadline: null,
		codeact: { id: "execution-1", cwd: "D:/fixture/中文工作区", code, reason: "将修改工作区配置文件，确认继续？" } };
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await editor.focus();
		channel.accept({ type: "dialogs", value: [pending] });
		const bar = page.locator(".codeact-confirmation");
		await expect(bar).toBeVisible(); await expect(editor).toBeFocused();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.locator('[data-tool-call-id="execution-1"]')).toHaveCount(1);
		await expect(page.locator('[data-tool-call-id="execution-1"] > [data-slot="collapsible"] > .activity-summary')).toContainText("等待确认");
		await bar.getByRole("button", { name: "查看待执行代码与工作区", exact: true }).click();
		await expect(bar.locator("pre")).toContainText('Path("配置.json")');
		await expect(bar).toContainText("D:/fixture/中文工作区");
		await bar.getByRole("button", { name: "拒绝并说明", exact: true }).click();
		await bar.getByRole("textbox", { name: "拒绝原因或替代方案", exact: true }).fill("先提供修改方案，不要写入");
		await bar.getByRole("button", { name: "提交拒绝", exact: true }).click();
		await expect.poll(() => submitted.length).toBe(1);
		expect(submitted[0]).toEqual({ action: "dialog", id: "dialog-1", value: "no", feedback: "先提供修改方案，不要写入" });
		await expect(bar.getByRole("button", { name: "提交拒绝", exact: true })).toBeDisabled();
		channel.accept({ type: "dialogs", value: [] }); release();
		await expect(bar).toHaveCount(0);

		channel.accept({ type: "dialogs", value: [{ ...pending, id: "dialog-2" }] });
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("textbox")).toHaveCount(0);
		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
		const approve = bar.getByRole("button", { name: "确认执行", exact: true });
		await approve.scrollIntoViewIfNeeded();
		await expect(approve).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		expect(await bar.evaluate(element => element.clientHeight)).toBeGreaterThan(80);
		await bar.evaluate(element => { element.scrollTop = 0; });
		await page.screenshot({ path: info.outputPath("codeact-confirmation.png") });
		await approve.click();
		await expect.poll(() => submitted.length).toBe(2);
		expect(submitted[1]).toEqual({ action: "dialog", id: "dialog-2", value: "yes" });
		channel.accept({ type: "dialogs", value: [] }); release();
		await expect(bar).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally { release(); channel.close(); }
});
