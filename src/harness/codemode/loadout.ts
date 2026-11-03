import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const codemodeAllowedTools: ReadonlySet<string> = new Set(["codemode", "read", "write", "edit", "find", "grep", "ls", "bash", "websearch", "webfetch"]);

/** 宿主工具与 CodeAct 平级；GUI、请求装配和执行边界共用开放集合。 */
export function codemodeHiddenDeclarations(tools: readonly Pick<ToolInfo, "name">[]): string[] {
	return tools.filter((tool) => !codemodeAllowedTools.has(tool.name)).map((tool) => tool.name);
}
