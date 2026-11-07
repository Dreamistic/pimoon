import { test, expect } from "@playwright/test";
import { replayTranscript } from "../../helpers/transcript-live-fixture.ts";
import { guiModelFixture, guiSnapshot } from "../../helpers/snapshot-fixture.ts";

function snapshot() {
	const model = guiModelFixture({ name: "GPT-5.4" });
	return { ...guiSnapshot(), model, models: [model] };
}

test("左侧栏拖动后记住宽度，折叠与恢复不丢失，双击可重置", async ({ page }) => {
	test.skip((page.viewportSize()?.width ?? 0) < 768, "窄屏使用抽屉导航");
	const channel = await replayTranscript(page, snapshot());
	try {
		const sidebar = page.getByRole("complementary", { name: "侧栏", exact: true });
		const handle = page.getByRole("separator", { name: "调整左侧栏宽度", exact: true });
		const width = () => sidebar.evaluate((element) => element.getBoundingClientRect().width);
		await expect(handle).toBeVisible();
		const initial = await width();
		const box = await handle.boundingBox();
		if (!box) throw new Error("缺少侧栏拖动边界");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
		await page.mouse.up();
		await expect.poll(width).toBeCloseTo(initial + 80, 0);
		await page.reload();
		await expect.poll(width).toBeCloseTo(initial + 80, 0);
		await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
		await expect.poll(width).toBeLessThan(initial);
		await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
		await expect.poll(width).toBeCloseTo(initial + 80, 0);
		await handle.dblclick();
		await expect.poll(width).toBeCloseTo(initial, 0);
		await handle.press("ArrowRight");
		await expect.poll(width).toBeCloseTo(initial + 10, 0);
		await handle.press("Enter");
		await expect.poll(width).toBeCloseTo(initial, 0);
	} finally { channel.close(); }
});

test("欢迎页只突出开始构建，模型控制成组且快捷入口仍填入草稿", async ({ page }) => {
	const channel = await replayTranscript(page, snapshot());
	try {
		const welcome = page.locator(".welcome-content");
		const build = welcome.getByRole("button", { name: "开始构建", exact: true });
		await expect(build).toBeVisible();
		const moon = page.locator(".pimoon-mark img");
		await expect(moon).toBeVisible();
		await expect.poll(() => moon.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
		await expect(welcome.locator('[data-variant="default"]')).toHaveCount(1);
		await expect(build).toHaveAttribute("data-variant", "default");
		for (const name of ["了解项目", "审查代码"])
			await expect(welcome.getByRole("button", { name, exact: true })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		const headingSize = await welcome.locator("h1").evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
		expect(headingSize).toBeGreaterThanOrEqual(24);
		expect(headingSize).toBeLessThanOrEqual(28);
		const controls = page.getByRole("group", { name: "模型与推理设置", exact: true });
		await expect(controls.getByRole("combobox", { name: "模型", exact: true })).toBeVisible();
		await expect(controls.getByRole("combobox", { name: "思考级别", exact: true })).toBeVisible();
		await build.click();
		const editor = page.getByRole("textbox", { name: "消息", exact: true });
		await expect(editor).toHaveValue("我想实现一个新功能，请先了解项目并和我讨论实现方案。");
		await expect(editor).toBeFocused();
		const send = page.getByRole("button", { name: "发送", exact: true });
		await expect(send).toBeEnabled();
		await expect.poll(() => send.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
		expect(await page.locator(".composer-bottom").evaluate((element) => {
			const input = document.querySelector(".composer-input");
			if (!input) throw new Error("缺少输入区域");
			return element.getBoundingClientRect().top - input.getBoundingClientRect().bottom;
		})).toBeGreaterThanOrEqual(8);
		expect(await page.locator(".composer-card").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	} finally { channel.close(); }
});
