import { expect, it } from "vitest";
import { DEFAULT_THEME_COLOR, generatePalette } from "../../../../../src/gui/frontend/ui/theme/palette.ts";
import { alpha, composite, contrast, hex, toHex } from "../../../../../src/gui/frontend/ui/theme/color.ts";
import { readGuiDefaults } from "../../../../../src/gui/host/config/preferences.ts";

it("默认深色表面使用紫灰色阶，启动主题色与配置一致", () => {
	const palette = generatePalette("dark", DEFAULT_THEME_COLOR);
	const expected = {
		background: "#17151D", "canvas-base": "#17151D", "glass-base": "#1D1A25",
		"toolbar-base": "#17151D", "panel-base": "#24212D", "soft-base": "#24212D", "elevated-base": "#2B2735",
		border: "#35303F", foreground: "#EAE5F0", "muted-foreground": "#A59BAB", "muted-decoration": "#716A7C", primary: "#A78BFA",
	};
	for (const [token, color] of Object.entries(expected))
		expect(toHex(palette[token as keyof typeof expected]), token).toBe(color);
	expect(readGuiDefaults().themeColor).toBe(DEFAULT_THEME_COLOR);
});

it("深色区域按明暗分层，普通表面与正文粗体不受强调色染色", () => {
	const defaults = generatePalette("dark", DEFAULT_THEME_COLOR);
	const custom = generatePalette("dark", "#00CC88");
	for (const key of ["background", "glass-base", "panel-base", "elevated-base", "selected", "user-background", "emphasis"] as const)
		expect(defaults[key], key).toEqual(custom[key]);
	expect(defaults.emphasis).toEqual(defaults.foreground);
	expect(defaults["user-background"]).toEqual(defaults["elevated-base"]);
});

it("左右侧栏使用相同的暗色不透明度，明亮桌面不会把侧栏洗成亮灰", () => {
	const { materials } = readGuiDefaults();
	const palette = generatePalette("dark", DEFAULT_THEME_COLOR);
	expect(materials.sidebar.darkOpacity).toBe(materials.inspector.darkOpacity);
	for (const backdrop of ["#1D2431", "#B7C2D6", "#FFFFFF"]) {
		const canvas = composite(alpha(palette["canvas-base"], materials.canvas.darkOpacity / 100), hex(backdrop));
		const sidebar = composite(alpha(palette["glass-base"], materials.sidebar.darkOpacity / 100), hex(backdrop));
		expect(contrast(canvas, sidebar)).toBeLessThan(1.3);
	}
});

for (const mode of ["light", "dark"] as const) {
	it.each(["#A78BFA", "#007AFF", "#AF52DE", "#FFFFFF", "#000000"])(`${mode} 主题色 %s 保持文字对比度与独立交互状态`, (seed) => {
		const palette = generatePalette(mode, seed);
		expect(palette.accent).not.toEqual(palette.selected);
		expect(palette.accent).not.toEqual(palette["secondary-active"]);
		expect(contrast(palette.primary, palette.background)).toBeGreaterThanOrEqual(4.5);
		for (const key of ["primary", "primary-hover", "primary-active"] as const)
			expect(contrast(palette[key], palette["primary-foreground"]), key).toBeGreaterThanOrEqual(4.5);
		for (const key of ["welcome-action", "welcome-action-hover", "welcome-action-active"] as const)
			expect(contrast(palette[key], palette["welcome-action-foreground"]), key).toBeGreaterThanOrEqual(4.5);
		for (const key of ["warning", "warning-hover", "warning-active"] as const)
			expect(contrast(palette[key], palette["warning-foreground"]), key).toBeGreaterThanOrEqual(4.5);
		for (const surface of ["background", "panel-base", "canvas-base", "glass-base", "control-base", "soft-base", "elevated-base", "accent"] as const) {
			for (const text of ["foreground", "muted-foreground", "destructive", "success", "warning"] as const)
				expect(contrast(palette[text], palette[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
		for (const token of ["syntax-comment", "syntax-keyword", "syntax-string", "syntax-function", "syntax-number", "syntax-attribute", "syntax-variable"] as const) {
			for (const surface of ["background", "panel-base"] as const)
				expect(contrast(palette[token], palette[surface]), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrast(palette["user-foreground"], palette["user-background"])).toBeGreaterThanOrEqual(4.5);
		expect(contrast(palette["user-link"], palette["user-background"])).toBeGreaterThanOrEqual(4.5);
	});
}

it.each(["#1D2431", "#B7C2D6"])("默认深色材质覆盖深蓝灰和银灰背景 %s 时保持正文对比度", (backdrop) => {
	const palette = generatePalette("dark", DEFAULT_THEME_COLOR);
	const { materials } = readGuiDefaults();
	for (const [base, opacity] of [[palette["canvas-base"], materials.canvas.darkOpacity], [palette["glass-base"], materials.inspector.darkOpacity]] as const) {
		const surface = composite(alpha(base, opacity / 100), hex(backdrop));
		for (const text of ["foreground", "muted-foreground", "success", "warning", "destructive"] as const)
			expect(contrast(palette[text], surface), text).toBeGreaterThanOrEqual(4.5);
	}
});
