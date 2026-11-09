import { selectSettingsCategory } from "../../../../helpers/settings-steps.ts";
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
	const message: CodeActMessage = assistant([{ type: "toolCall", id: "execution-1", name: "execute",
        arguments: { code, desc: "检查并更新工作区配置", confirm: "确认写入配置？" } }], "toolUse");
	const snapshot = { ...guiSnapshot(), model: guiModelFixture(), models: [guiModelFixture()], running: true, streaming: true,
		contextEntryIds: ["user", "execution"], entries: [
			{ id: "user", parentId: null, type: "message" as const, timestamp: new Date(1).toISOString(), label: undefined, messages: [{ role: "user" as const, content: "检查配置", timestamp: 1 }] },
			{ id: "execution", parentId: "user", type: "message" as const, timestamp: new Date(100).toISOString(), label: undefined, messages: [message] },
		], liveTools: [{ toolCallId: "execution-1", toolName: "execute", args: { code, desc: "检查并更新工作区配置" }, output: { kind: "inline" as const, value: { content: [], details: { confirmationPending: true } } } }] };
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

test("工具审批共用非模态入口，用户明确选择单次操作，意见与真实范围一次提交", async ({ page }, info) => {
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
		options: ["Allow once", "Deny"], approval: {
			tool: "process_run", cwd: "D:/fixture/中文工作区", reason: "先检查项目状态，避免覆盖未提交内容。", summary: '["git","status"]',
			content: [{ style: "text", text: 'argv: ["git","status"]\nenv: {}\nReason: default process_run approval policy' }], recommended: "once",
			card: { title: "检查项目状态", explanation: "只查看状态", recommendation: "Allow once", recommendationReason: "仅本次操作",
				feedbackPlaceholder: "补充要求", actions: [
					{ choice: "Allow once", label: "本次查看" },
					{ choice: "Deny", label: "暂不查看" }] },
			scopes: [
				{ scope: "once", choice: "Allow once", label: "仅本次", detail: "只允许当前暂停的调用；不重跑整段代码。" },
			],
		} };
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true }); await editor.focus();
		channel.accept({ type: "dialogs", value: [pending] });
		const bar = page.locator(".approval-bar");
		await expect(bar).toBeVisible(); await expect(editor).toBeFocused();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(bar).toContainText('["git","status"]');
		await bar.getByRole("radio", { name: "本次查看 · 仅本次 · AI 建议", exact: true }).check();
		await expect(bar.locator(".approval-bar-range")).toContainText("当前暂停的调用");
		await bar.getByRole("button", { name: "查看实际操作与拦截原因", exact: true }).click();
		await expect(bar.locator("pre")).toContainText("default process_run approval policy");
		await bar.getByRole("button", { name: "补充意见", exact: true }).click();
		await bar.getByRole("textbox", { name: "审批意见", exact: true }).fill("只允许本次，今后仍需说明原因");
		channel.accept({ type: "dialogs", value: [pending] });
		await expect(bar.getByRole("radio", { name: "本次查看 · 仅本次 · AI 建议", exact: true })).toBeChecked();
		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
		const approve = bar.getByRole("button", { name: "本次查看", exact: true });
		await approve.scrollIntoViewIfNeeded(); await expect(approve).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await page.screenshot({ path: info.outputPath("permission-approval.png") });
		await approve.click(); await expect.poll(() => submitted.length).toBe(1);
		expect(submitted[0]).toEqual({ action: "dialog", id: pending.id, value: "Allow once", feedback: "只允许本次，今后仍需说明原因" });
		await expect(bar.getByRole("button", { name: "正在提交…", exact: true })).toBeDisabled();
		await expect(bar.getByRole("radio", { name: "本次查看 · 仅本次 · AI 建议", exact: true })).toBeDisabled();
		channel.accept({ type: "dialogs", value: [] }); release(); await expect(bar).toHaveCount(0);
		expect(submitted).toHaveLength(1);
	} finally { release(); channel.close(); }
});

test("AI推荐拒绝时不预选批准，需主动选范围才能覆盖建议", async ({ page }) => {
	const channel = await replayTranscript(page, { ...guiSnapshot(), running: true });
	const submitted: GuiAction[] = [];
	await page.route("http://127.0.0.1:43177/api/action", async route => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action === "dialog") submitted.push(value);
		await route.fulfill({ json: null });
	});
	const pending: GuiDialog = { id: "deny-recommendation", kind: "approval", title: "核对构建", message: "", initial: "", deadline: null,
		options: ["Allow once", "Deny"], approval: {
			tool: "process_run", cwd: "D:/fixture", reason: "本次目标需要确认", summary: '["bun","build"]', content: [], recommended: null,
			card: { title: "核对构建", explanation: "本次目标需要确认", decision: "deny", recommendation: "Deny",
				recommendationReason: "核对后再执行", feedbackPlaceholder: "补充说明",
				actions: [{ choice: "Allow once", label: "只运行这次构建" }, { choice: "Deny", label: "本次不构建" }] },
			scopes: [{ scope: "once", choice: "Allow once", label: "仅本次", detail: "当前构建" }],
		} };
	try {
		channel.accept({ type: "dialogs", value: [pending] });
		const bar = page.locator(".approval-bar");
		await expect(bar).toBeVisible();
		await expect(bar.getByRole("radio")).not.toBeChecked();
		await expect(bar.getByRole("button", { name: "选择范围后仍要执行", exact: true })).toBeDisabled();
		await expect(bar.getByRole("button", { name: "拒绝 · 本次不构建 · AI推荐", exact: true })).toBeEnabled();
		await bar.getByRole("radio").check();
		await bar.getByRole("button", { name: "只运行这次构建", exact: true }).click();
		await expect.poll(() => submitted.length).toBe(1);
		expect(submitted[0]).toEqual({ action: "dialog", id: pending.id, value: "Allow once" });
	} finally { channel.close(); }
});


test("批次互动组件收集澄清而不执行，确认勾选后才批准整段", async ({ page }) => {
	const channel = await replayTranscript(page, { ...guiSnapshot(), running: true });
	const submitted: GuiAction[] = [];
	await page.route("http://127.0.0.1:43177/api/action", async route => {
		const { value } = route.request().postDataJSON() as { value: GuiAction };
		if (value.action === "dialog") submitted.push(value);
		await route.fulfill({ json: null });
	});
	const pending: GuiDialog = { id: "batch-question", kind: "approval", title: "核对整段清理计划", message: "", initial: "", deadline: null,
		options: ["Allow once", "Deny", "Discuss"], approval: {
			tool: "process_run", cwd: "D:/fixture", reason: "需要你决定当前范围", summary: "清理两个目标", content: [], recommended: "once", discuss: true,
			block: { id: "block-1", code: 'subprocess.run(["cleanup", "first"])\nsubprocess.run(["cleanup", "second"])', codeHash: "fixture", plannedCalls: 2, dispatchedCalls: 0, unresolvedLines: [] },
			card: { decision: "ask", title: "核对范围", explanation: "确认后才执行", recommendation: "Allow once", recommendationReason: "仅本段", feedbackPlaceholder: "补充要求",
				actions: [{ choice: "Allow once", label: "批准本段" }, { choice: "Deny", label: "停止本段" }],
				widgets: [{ kind: "facts", title: "影响范围", items: [{ label: "目标", value: "两个本地目录 <script>not executable</script>" }] },
					{ kind: "question", id: "target", title: "如何处理？", options: ["先预览", "保留两个目录"] }] },
			scopes: [{ scope: "once", choice: "Allow once", label: "本次 CodeAct", detail: "仅本段余下确定调用，不重跑。" }],
		} };
	try {
		const editor = page.getByRole("textbox", { name: "消息", exact: true }); await editor.focus();
		channel.accept({ type: "dialogs", value: [pending] });
		const bar = page.locator(".approval-bar"); await expect(bar).toBeVisible(); await expect(editor).toBeFocused();
		await expect(bar).toContainText("<script>not executable</script>"); expect(await bar.locator("script").count()).toBe(0);
		await expect(bar.getByRole("button", { name: "批准本段", exact: true })).toBeDisabled();
		await bar.getByRole("radio", { name: "先预览", exact: true }).check();
		await bar.getByRole("button", { name: "提交答案，不执行", exact: true }).click();
		await expect.poll(() => submitted.length).toBe(1);
		expect(submitted[0]).toEqual({ action: "dialog", id: pending.id, value: "Discuss", answers: { target: "先预览" } });
		channel.accept({ type: "dialogs", value: [] }); await expect(bar).toHaveCount(0);
		const approved = structuredClone(pending); approved.id = "batch-confirm";
		if (!approved.approval?.card) throw new Error("missing card");
		approved.approval.card.widgets = [{ kind: "comparison", title: "方案对比", items: [{ label: "当前方案", value: "仅清理展示目标" }, { label: "替代方案", value: "停止并由主模型重新规划" }] },
			{ kind: "checklist", title: "确认影响", items: [{ id: "risk", label: "我确认展示的两个目标可清理", required: true }] }];
		channel.accept({ type: "dialogs", value: [approved] });
		await expect(bar.getByRole("button", { name: "批准本段", exact: true })).toBeDisabled();
		await bar.getByRole("checkbox", { name: "我确认展示的两个目标可清理", exact: false }).check();
		await page.emulateMedia({ colorScheme: "dark" });
		await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
		const button = bar.getByRole("button", { name: "批准本段", exact: true }); await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await button.click(); await expect.poll(() => submitted.length).toBe(2);
		expect(submitted[1]).toEqual({ action: "dialog", id: approved.id, value: "Allow once", answers: { risk: true } });
	} finally { channel.close(); }
});


test("审批诊断可查看、标注和清除，导出前先展示脱敏预览", async ({ page }) => {
	const channel = await replayTranscript(page, guiSnapshot());
	const id = "20261109-00000000-0000-4000-8000-000000000001";
	let cleared = false;
	const events: { at: string; phase: string; data: unknown; redactions: number; truncated: boolean }[] = [
		{ at: "2026-11-09T10:00:00Z", phase: "request", data: { payload: "[redacted] fixture" }, redactions: 1, truncated: false },
		{ at: "2026-11-09T10:00:01Z", phase: "response", data: { decision: "ask" }, redactions: 0, truncated: false },
	];
	const actions: GuiAction[] = [];
	await page.route("http://127.0.0.1:43177/api/query", async route => {
		const { value } = route.request().postDataJSON() as { value: { query: string } };
		if (value.query === "approvalTraces") { await route.fulfill({ json: cleared ? [] : [{ id, at: events[0]?.at, phases: events.map(event => event.phase), bytes: 2048 }] }); return; }
		if (value.query === "approvalTrace") { await route.fulfill({ json: { id, events } }); return; }
		if (value.query === "moduleConfig") { await route.fulfill({ json: { path: "/fixture/approval-ai.jsonc", content: "{}", defaults: JSON.stringify({ enabled: true, routine: true, model: "fixture/model", timeout_ms: 60000, diagnostics: { enabled: true, retention_days: 7, max_mb: 32 } }), options: {}, arrayOptions: {}, fields: {} } }); return; }
		await route.fallback();
	});
	await page.route("http://127.0.0.1:43177/api/action", async route => {
		const { value } = route.request().postDataJSON() as { value: GuiAction }; actions.push(value);
		if (value.action === "annotateApprovalTrace") events.push({ at: "2026-11-09T10:00:02Z", phase: "annotation", data: { actor: "user", label: value.label }, redactions: 0, truncated: false });
		if (value.action === "clearApprovalTraces") cleared = true;
		await route.fulfill({ json: null });
	});
	try {
		if ((page.viewportSize()?.width ?? 1200) < 768) await page.getByRole("button", { name: "菜单", exact: true }).click();
		await page.getByRole("button", { name: "设置", exact: true }).click(); await selectSettingsCategory(page, "权限与安全");
		const panel = page.getByRole("region", { name: "审批 AI 诊断", exact: true });
		await expect(panel.locator(".approval-trace-list button")).toHaveCount(1);
		await panel.locator(".approval-trace-list button").click();
		await panel.getByRole("button", { name: "标记误拦截", exact: true }).click();
		await expect.poll(() => actions.some(action => action.action === "annotateApprovalTrace" && action.id === id && action.label === "false_block")).toBe(true);
		await expect(panel).toContainText("用户标注");
		await panel.getByRole("button", { name: "脱敏导出预览", exact: true }).click();
		await expect(panel.locator("pre").last()).toContainText("[redacted] fixture");
		await panel.getByRole("button", { name: "清除详细诊断", exact: true }).click();
		await expect(panel).toContainText("不会撤销授权或删除会话");
		await panel.getByRole("button", { name: "确认清除", exact: true }).click();
		await expect(panel).toContainText("暂无详细审批记录");
	} finally { channel.close(); }
});
