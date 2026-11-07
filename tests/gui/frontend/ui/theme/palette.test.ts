import { expect, it } from "vitest";
import { DEFAULT_THEME_COLOR, generatePalette } from "../../../../../src/gui/frontend/ui/theme/palette.ts";
import { alpha, composite, contrast, hex, toHex } from "../../../../../src/gui/frontend/ui/theme/color.ts";
import { readGuiDefaults } from "../../../../../src/gui/host/config/preferences.ts";

it("默认深色表面使用紫灰色阶，启动主题色与配置一致", () => {
	const palette = generatePalette("dark", DEFAULT_THEME_COLOR);
	const expected = {
		background: "#191720", "canvas-base": "#191720", "glass-base": "#1D1A26",
		"toolbar-base": "#191720", "panel-base": "#24212E", "soft-base": "#292532",
		border: "#35303F", foreground: "#ECE8F2", "muted-foreground": "#A39BAF", primary: "#A78BFA", "brand-soft": "#8065C5",
	};
	for (const [token, color] of Object.entries(expected))
		expect(toHex(palette[token as keyof typeof expected]), token).toBe(color);
	expect(readGuiDefaults().themeColor).toBe(DEFAULT_THEME_COLOR);
});

for (const mode of ["light", "dark"] as const) {
	it.each(["#A78BFA", "#007AFF", "#AF52DE", "#FFFFFF", "#000000"])(`${mode} 主题色 %s 保持文字对比度与独立交互状态`, (seed) => {
		const palette = generatePalette(mode, seed);
		expect(palette.accent).not.toEqual(palette.selected);
		expect(palette.accent).not.toEqual(palette["secondary-active"]);
		expect(contrast(palette.primary, palette.background)).toBeGreaterThanOrEqual(4.5);
		for (const key of ["primary", "primary-hover", "primary-active"] as const)
			expect(contrast(palette[key], palette["primary-foreground"]), key).toBeGreaterThanOrEqual(4.5);
		for (const key of ["warning", "warning-hover", "warning-active"] as const)
			expect(contrast(palette[key], palette["warning-foreground"]), key).toBeGreaterThanOrEqual(4.5);
		for (const surface of ["background", "panel-base", "canvas-base", "glass-base", "control-base", "soft-base", "accent"] as const) {
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
