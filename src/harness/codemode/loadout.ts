import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const codemodeAllowedTools: ReadonlySet<string> = new Set(["codemode", "read", "write", "edit", "find", "grep", "ls", "bash", "websearch", "webfetch"]);

/** 执行能力只通过 CodeAct 声明；宿主保留原有工具实现和检查。 */
export function codemodeHiddenDeclarations(tools: readonly Pick<ToolInfo, "name">[]): string[] {
	return tools.filter((tool) => tool.name !== "codemode").map((tool) => tool.name);
}

/** 旧会话的底层工具选择保留为能力开关，并补齐唯一执行入口。 */
export function codemodeSelection(names: readonly string[]): string[] {
	return names.some(name => codemodeAllowedTools.has(name)) && !names.includes("codemode")
		? [...names, "codemode"] : [...names];
}
