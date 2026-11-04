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
		const bar = page.locator(".approval-bar");
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

test("工具审批共用非模态入口，用户可收窄 AI 建议，意见与真实范围一次提交", async ({ page }, info) => {
	const model = guiModelFixture();
	const snapshot = { ...guiSnapshot(), model, models: [model], running: true, streaming: true };
	const channel = await replayTranscript(page, snapshot);
	const submitted: GuiAction[] = [];
	let release = () => {};
	await page.route("http://127.0.0.1:43177/api/action", async route => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action === "dialog") { submitted.push(value); await new Promise<void>(resolve => { release = resolve; }); }
		await route.fulfill({ json: null });
	});
	const pending: GuiDialog = { id: "permission-1", kind: "approval", title: "操作审批", message: "", initial: "", deadline: null,
		options: ["Allow once", "Allow for session", "Always allow similar", "Deny"], approval: {
			tool: "process_run", cwd: "D:/fixture/中文工作区", reason: "先检查项目状态，避免覆盖未提交内容。", summary: '["git","status"]',
			content: [{ style: "text", text: 'argv: ["git","status"]\nenv: {}\nReason: default process_run approval policy' }], recommended: "persistent",
			card: { title: "检查项目状态", explanation: "只查看状态", recommendation: "Always allow similar", recommendationReason: "重复检查可以记住精确规则",
				feedbackPlaceholder: "补充要求", actions: [
					{ choice: "Allow once", label: "本次查看" }, { choice: "Allow for session", label: "本会话查看" },
					{ choice: "Always allow similar", label: "记住这项检查" }, { choice: "Deny", label: "暂不查看" }] },
			scopes: [
				{ scope: "once", choice: "Allow once", label: "仅本次", detail: "只允许当前暂停的调用；不重跑整段代码。" },
				{ scope: "session", choice: "Allow for session", label: "本会话相同操作", detail: "同一工作目录、argv 和环境覆盖。" },
				{ scope: "persistent", choice: "Always allow similar", label: "以后按所示规则", detail: 'process_run command: {"argv":["git","status"],"env":{}} in D:/fixture/中文工作区' },
			],
		} };
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true }); await editor.focus();
		channel.accept({ type: "dialogs", value: [pending] });
		const bar = page.locator(".approval-bar");
		await expect(bar).toBeVisible(); await expect(editor).toBeFocused();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(bar).toContainText('["git","status"]');
		await expect(bar.getByRole("radio", { name: "记住这项检查 · 以后按所示规则 · AI 建议", exact: true })).toBeChecked();
		await expect(bar.getByRole("button", { name: "记住这项检查", exact: true })).toBeVisible();
		await bar.getByRole("radio", { name: "本次查看 · 仅本次", exact: true }).check();
		await expect(bar.locator(".approval-bar-range")).toContainText("当前暂停的调用");
		await bar.getByRole("button", { name: "查看实际操作与拦截原因", exact: true }).click();
		await expect(bar.locator("pre")).toContainText("default process_run approval policy");
		await bar.getByRole("button", { name: "补充意见", exact: true }).click();
		await bar.getByRole("textbox", { name: "审批意见", exact: true }).fill("只允许本次，今后仍需说明原因");
		channel.accept({ type: "dialogs", value: [pending] });
		await expect(bar.getByRole("radio", { name: "本次查看 · 仅本次", exact: true })).toBeChecked();
		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
		const approve = bar.getByRole("button", { name: "本次查看", exact: true });
		await approve.scrollIntoViewIfNeeded(); await expect(approve).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.screenshot({ path: info.outputPath("permission-approval.png") });
		await approve.click(); await expect.poll(() => submitted.length).toBe(1);
		expect(submitted[0]).toEqual({ action: "dialog", id: pending.id, value: "Allow once", feedback: "只允许本次，今后仍需说明原因" });
		await expect(bar.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
		await expect(bar.getByRole("radio", { name: "本次查看 · 仅本次", exact: true })).toBeDisabled();
		channel.accept({ type: "dialogs", value: [] }); release(); await expect(bar).toHaveCount(0);
		expect(submitted).toHaveLength(1);
	} finally { release(); channel.close(); }
});
