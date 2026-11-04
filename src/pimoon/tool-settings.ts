import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/** 一次性升级已移除的工具名，保留原有能力选择、注释及其他设置。 */
export function migrateToolSettings(original: string): string {
	const errors: ParseError[] = [];
	const settings: unknown = parse(original.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
	if (errors.length || typeof settings !== "object" || settings === null || Array.isArray(settings)) return original;
	let updated = original;
	if ("defaultTools" in settings && Array.isArray(settings.defaultTools) && settings.defaultTools.every((name): name is string => typeof name === "string")) {
		const configured = settings.defaultTools;
		const tools = configured.flatMap(name => {
			const prefix = name.startsWith("+") || name.startsWith("-") ? name[0] : "";
			const tool = prefix ? name.slice(1) : name;
			return tool === "codemode" ? [] : [`${prefix}${tool === "bash" ? "process_run" : tool}`];
		});
		if (tools.length !== configured.length || tools.some((tool, index) => tool !== configured[index]))
			updated = applyEdits(updated, modify(updated, ["defaultTools"], [...new Set(tools)], {}));
	}
	if ("codemode" in settings) updated = applyEdits(updated, modify(updated, ["codemode"], undefined, {}));
	return updated;
}
