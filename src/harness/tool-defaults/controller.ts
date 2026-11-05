import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { saveUserToolDefaults } from "./config.ts";
import { initialToolDefaults } from "./initial.ts";
import { isCodeActFunction } from "../../pimoon/codeact/functions.ts";

export type ToolSelectionItem = Pick<ToolInfo, "name" | "description" | "exposure"> & (
	| { available: true; enabled: boolean }
	| { available: false; enabled: false }
);

export class ToolSelectionController {
	private baseline: string[] | undefined;

	constructor(private readonly pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">) {}

	/** 入口与宿主能力共用选择状态；未交付的上游工具不可启用。 */
	listTools(tools = this.pi.getAllTools(), activeTools = this.pi.getActiveTools()): ToolSelectionItem[] {
		const active = new Set(activeTools);
		return tools.filter((tool) => tool.exposure !== "hidden" && isCodeActFunction(tool.name)).map(({ name, description, exposure }) => {
			const available = this.selectable({ name, exposure });
			return { name, description, exposure, ...(available
				? { available: true as const, enabled: active.has(name) }
				: { available: false as const, enabled: false as const }) };
		});
	}

	/** 恢复交给 SDK，此处只应用新会话默认值和本地可用性约束。 */
	refresh(initialTools?: readonly string[]): void {
		this.apply(initialTools ?? this.pi.getActiveTools());
		this.baseline ??= this.selectedNames();
	}

	set(name: string, enabled: boolean): void {
		this.setMany([{ name, enabled }]);
	}

	setMany(choices: readonly { name: string; enabled: boolean }[]): void {
		const available = this.selectableNames();
		const selectable = choices.filter(({ name }) => available.has(name));
		if (selectable.length === 0) return;
		const names = new Set(this.pi.getActiveTools());
		for (const { name, enabled } of selectable) {
			if (enabled) names.add(name); else names.delete(name);
		}
		this.apply([...names]);
	}

	hasUserDefaultChanges(defaultTools: string[] | undefined): boolean {
		const baseline = this.baseline;
		if (!baseline) return false;
		const defaults = initialToolDefaults({
			getActiveTools: () => baseline,
			getSettings: () => defaultTools === undefined ? {} : { defaultTools },
		}, [], {}) ?? baseline;
		const available = this.selectableNames();
		const expected = new Set(defaults.filter(name => available.has(name)));
		const current = this.selectedNames();
		return current.length !== expected.size || current.some((name) => !expected.has(name));
	}

	persistUserDefaults(): Promise<string> {
		return saveUserToolDefaults(this.selectedNames());
	}

	private selectedNames(): string[] {
		const active = new Set(this.pi.getActiveTools());
		return [...this.selectableNames()].filter((name) => active.has(name));
	}

	private selectable(tool: Pick<ToolInfo, "name" | "exposure">): boolean {
		return isCodeActFunction(tool.name) && tool.exposure !== "hidden";
	}

	private selectableNames(): Set<string> {
		return new Set(this.pi.getAllTools().filter((tool) => this.selectable(tool)).map((tool) => tool.name));
	}

	private apply(names: readonly string[]): void {
		const available = this.selectableNames();
		const filtered = names.filter((name) => available.has(name));
		// execute 是固定协议入口，不是可开关的内部函数；未注册时不添加。
		const selected = this.pi.getAllTools().some(tool => tool.name === "execute")
			? ["execute", ...filtered] : filtered;
		const current = this.pi.getActiveTools();
		if (selected.length !== current.length || selected.some((name, index) => name !== current[index])) this.pi.setActiveTools(selected);
	}
}
