import type { McpExposure } from "@earendil-works/pi-coding-agent";

const labels = {
	codemode: "CodeAct 函数",
	deferred: "按需发现函数",
	direct: "默认启用函数",
	hidden: "隐藏",
} satisfies Record<McpExposure, string>;

export function McpExposureLabel({ exposure }: { exposure: McpExposure }) {
	return <span className="mcp-exposure">{labels[exposure]}</span>;
}
