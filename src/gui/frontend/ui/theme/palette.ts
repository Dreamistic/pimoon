import { alpha, composite, contrast, hex, mix, type Color } from "./color.ts";
import { GUI_BACKGROUNDS } from "../../../shared/theme.ts";

export const DEFAULT_THEME_COLOR = "#A78BFA";
const black = hex("#000000"), white = hex("#FFFFFF");

function readable(seed: Color, backgrounds: readonly Color[], dark: boolean, minimum = 4.5): Color {
	const target = dark ? white : black;
	for (let step = 0; step <= 20; step++) {
		const color = mix(seed, target, step / 20);
		if (backgrounds.every((background) => contrast(color, background) >= minimum)) return color;
	}
	return target;
}

function onColor(background: Color): Color {
	return contrast(black, background) >= contrast(white, background) ? black : white;
}

// 白色主题、黑色主题也需要交互反馈，并保持实心按钮文字的对比度。
function interaction(color: Color, foreground: Color, target: Color, amount: number): Color {
	const toward = contrast(color, target) < 1.01 ? (target === white ? black : white) : target;
	for (let step = 10; step > 0; step--) {
		const candidate = mix(color, toward, amount * step / 10);
		if (contrast(candidate, foreground) >= 4.5) return candidate;
	}
	return color;
}

/** 从 OneChat 的 AppPalette 移植。浏览器画布和遮挡文字的列表底色使用不透明颜色。 */
export function generatePalette(mode: "light" | "dark", themeColor: string) {
	const dark = mode === "dark", seed = hex(themeColor);
	const tint = dark ? 0 : 0.012;
	const background = mix(hex(GUI_BACKGROUNDS[mode]), seed, tint * 0.5);
	const panel = mix(hex(dark ? "#24212D" : "#FFFFFF"), seed, tint);
	const sidebar = mix(hex(dark ? "#1D1A25" : "#EBEBF0DC"), seed, tint);
	const toolbar = dark ? background : mix(hex("#F7F7F8DC"), seed, tint * 0.7);
	const composer = dark ? panel : hex("#F2F2F4");
	const elevated = dark ? hex("#2B2735") : panel;
	const foreground = hex(dark ? "#EAE5F0" : "#1D1D1F");
	const secondary = dark ? panel : composite(hex("#3C3C4324"), background);
	const hover = dark ? mix(panel, elevated, 0.6) : composite(hex("#3C3C4330"), background);
	const active = dark ? mix(elevated, foreground, 0.05) : composite(hex("#3C3C4340"), background);
	// 深色选中态只提高表面亮度，强调色保留给选中图标和文字。
	const selected = dark ? elevated : mix(composite(sidebar, background), seed, 0.18);
	const surfaces = [background, panel, composer, elevated, composite(sidebar, background), hover, secondary, selected, ...(dark ? [active] : [])];
	const primary = readable(seed, [background], dark);
	const primaryForeground = onColor(primary);
	const welcomeAction = dark ? mix(panel, primary, 0.42) : primary;
	const welcomeActionForeground = onColor(welcomeAction);
	// 选中态上的主题色文字/图标需对 selected 底单独校正, 直接用 primary 对比度不足.
	const selectedForeground = readable(seed, [selected], dark);
	const userBackground = dark ? elevated : mix(panel, primary, 0.16);
	const userLink = readable(seed, [userBackground], dark);
	const muted = readable(hex(dark ? "#A59BAB" : "#48484A"), surfaces, dark);
	const danger = readable(hex(dark ? "#FF453A" : "#D70015"), surfaces, dark);
	const success = readable(hex(dark ? "#30D158" : "#248A3D"), surfaces, dark);
	const warning = readable(hex(dark ? "#FFCC00" : "#936B22"), surfaces, dark);
	const dangerForeground = onColor(danger);
	const warningForeground = onColor(warning);
	const surfaceShine = hex(dark ? "#FFFFFF08" : "#FFFFFF80");
	const scrollbarBackgrounds = [...surfaces, userBackground];
	const scrollbar = (minimum: number) => readable(mix(background, primary, 0.04), scrollbarBackgrounds, dark, minimum);

	const syntax = (darkColor: string, lightColor: string) => readable(hex(dark ? darkColor : lightColor), [background, panel], dark);

	return {
		background, foreground,
		primary, "primary-foreground": primaryForeground,
		"primary-hover": interaction(primary, primaryForeground, white, 0.07),
		"primary-active": interaction(primary, primaryForeground, black, 0.1),
		"welcome-action": welcomeAction, "welcome-action-foreground": welcomeActionForeground,
		"welcome-action-hover": interaction(welcomeAction, welcomeActionForeground, white, 0.07),
		"welcome-action-active": interaction(welcomeAction, welcomeActionForeground, black, 0.1),
		secondary, "secondary-active": active,
		accent: hover, selected, "selected-foreground": selectedForeground,
		surface: panel, "panel-base": panel, "elevated-base": elevated,
		"canvas-base": dark ? background : mix(background, alpha(sidebar, 1), 0.4),
		"glass-base": alpha(sidebar, 1), "toolbar-base": alpha(toolbar, 1),
		"control-base": panel,
		"soft-base": composer,
		"muted-decoration": hex(dark ? "#716A7C" : "#8E8799"),
		"muted-foreground": muted,
		border: hex(dark ? "#35303F" : "#3C3C4330"), ring: primary,
		link: primary, emphasis: dark ? foreground : mix(foreground, primary, 0.22),
		selection: alpha(primary, dark ? 0.32 : 0.22),
		destructive: danger, "destructive-foreground": dangerForeground,
		"destructive-hover": interaction(danger, dangerForeground, white, 0.07),
		"destructive-active": interaction(danger, dangerForeground, black, 0.1),
		"danger-soft": alpha(danger, dark ? 0.14 : 0.095), success, warning,
		"warning-foreground": warningForeground,
		"warning-hover": interaction(warning, warningForeground, white, 0.07),
		"warning-active": interaction(warning, warningForeground, black, 0.1),
		"git-added": success, "git-deleted": danger, "git-modified": warning,
		"floating-shadow": hex(dark ? "#0000005C" : "#1D1D1F24"),
		"surface-shine": surfaceShine,
		"soft-shine": dark ? surfaceShine : hex("#FFFFFF20"),
		"surface-edge": dark ? alpha(foreground, 0.05) : hex("#1D1D1F1C"),
		"control-thumb": white,
		"meter-track": alpha(dark ? white : black, 0.1),
		"scrollbar-thumb": scrollbar(3), "scrollbar-thumb-hover": scrollbar(4.5), "scrollbar-thumb-active": scrollbar(6),
		"user-background": userBackground, "user-foreground": foreground,
		"user-muted-foreground": readable(dark ? muted : mix(muted, primary, 0.06), [userBackground], dark),
		"user-link": userLink, "user-emphasis": dark ? foreground : mix(foreground, userLink, 0.24),
		"user-border": alpha(dark ? foreground : primary, dark ? 0.05 : 0.14),
		"user-surface": composite(alpha(white, dark ? 0.08 : 0.44), userBackground),
		"user-selection": alpha(primary, dark ? 0.22 : 0.18),
		"syntax-comment": syntax("#94A3B8", "#6B7280"),
		"syntax-keyword": syntax("#7DD3FC", "#1D4ED8"),
		"syntax-string": syntax("#34D399", "#047857"),
		"syntax-function": syntax("#A5B4FC", "#7C3AED"),
		"syntax-number": syntax("#F472B6", "#B45309"),
		"syntax-attribute": syntax("#FCD34D", "#2563EB"),
		"syntax-variable": syntax("#C084FC", "#6D28D9"),
	};
}
