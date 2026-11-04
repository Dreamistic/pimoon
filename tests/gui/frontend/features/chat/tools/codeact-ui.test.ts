import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { GuiSnapshot } from "../../../../../../src/gui/shared/protocol/state.ts";
import { ToolSelection } from "../../../../../../src/gui/frontend/features/chat/tools/tool-selection.tsx";
import { ToolActivity } from "../../../../../../src/gui/frontend/features/chat/tools/tool-activity.tsx";
import type { ToolActivity as Activity } from "../../../../../../src/gui/frontend/features/chat/tools/activity.ts";
import { renderWithMemory } from "../../../../helpers/render.ts";

const tools: GuiSnapshot["tools"] = [
	{ name: "read", exposure: "direct", description: "Read", enabled: true, available: true, callable: true },
	{ name: "process_run", exposure: "direct", description: "Run argv", enabled: false, available: true, callable: false },
	{ name: "search", exposure: "deferred", description: "Search", enabled: false, available: true, callable: true },
];
const tool: Activity = { id: "code-1", name: "codeact", state: "running", args: { code: 'read(path="a.ts")' }, output: undefined,
	nestedCalls: { complete: false, calls: [
		{ id: "code-1/1", name: "find", arguments: { query: "a.ts" }, status: "ok", durationMs: 10 },
		{ id: "code-1/2", name: "read", arguments: { path: "a.ts" }, status: "unfinished" },
	] } };
const renderTool = (value: Activity, expanded?: boolean) => parseHTML(renderWithMemory(createElement(ToolActivity, { tool: value }), new Map(expanded === undefined ? [] : [[`tool:${value.id}`, expanded]]))).document;
const renderSelection = (value = tools) => parseHTML(renderWithMemory(createElement(ToolSelection, { snapshot: { tools: value, modelTools: [], toolDefaultsChanged: false, toolPreset: null }, send: async () => true, disabled: false }))).document;

describe("固定 CodeAct 与函数权限", () => {
	it("没有 codemode 工具复选框，函数开关明确表示 Python 能力", () => {
		const doc = renderSelection();
		expect(doc.querySelector('[data-tool-option="codemode"]')).toBeNull();
		expect(doc.querySelector('[aria-label="CodeAct 函数"]')?.textContent).toContain("固定使用 Python 编排");
		expect(doc.querySelector('[data-tool-option="read"] .tool-callable-state')?.textContent).toBe("Python 函数");
		expect(doc.querySelector('[aria-label="read"]')?.getAttribute("aria-checked")).toBe("true");
		expect(doc.querySelector('[aria-label="process_run"]')?.getAttribute("aria-checked")).toBe("false");
	});
	it("自动可调用函数保持自动状态，搜索入口不成为模型直调工具", () => {
		const doc = renderSelection([...tools, { name: "tool_search", exposure: "direct", description: "Search functions", callable: true, enabled: true, available: true }]);
		expect(doc.querySelector('[aria-label="search"]')?.hasAttribute("disabled")).toBe(true);
		expect(doc.querySelector('[data-tool-option="search"] .tool-callable-state')?.textContent).toBe("自动");
		expect(doc.querySelector('[aria-label="tool_search"]')?.hasAttribute("disabled")).toBe(true);
	});
	it("MCP 函数仍可按服务与共享资源控制", () => {
		const doc = renderSelection([...tools,
			{ name: "mcp__demo__probe", description: "Probe", exposure: "codemode", mcp: true, available: true, enabled: false, callable: true, mcpServer: { name: "demo", tool: "probe", exposure: "codemode" } },
			{ name: "read_mcp_resource", description: "Resource", exposure: "codemode", mcp: true, available: true, enabled: true, callable: true },
		]);
		expect(doc.querySelector('[aria-label="demo 服务工具"]')?.getAttribute("aria-checked")).toBe("true");
		expect(doc.querySelector('[aria-label="展开 demo"]')?.getAttribute("aria-expanded")).toBe("false");
		expect(doc.querySelector('.mcp-shared-tools [aria-label="read_mcp_resource"]')?.getAttribute("aria-checked")).toBe("true");
	});
});

describe("CodeAct 执行容器", () => {
	it("根据实际调用显示操作、目标和批量状态，不猜测源码", () => {
		const single = renderTool({ ...tool, nestedCalls: { complete: true, calls: [{ id: "read-1", name: "read", status: "ok", arguments: { path: "App.css" } }] } });
		expect(single.querySelector(".activity-label")?.textContent).toBe("读取"); expect(single.querySelector(".activity-target")?.textContent).toBe("App.css");
		const pure = renderTool({ ...tool, args: { code: 'print("read(path=foo)")' }, nestedCalls: { complete: true, calls: [] } });
		expect(pure.querySelector(".activity-label")?.textContent).toBe("代码执行");
		const batch = renderTool({ ...tool, nestedCalls: { complete: true, calls: ["a", "b"].map(id => ({ id, name: "read", status: "ok" })) } });
		expect(batch.querySelector(".activity-label")?.textContent).toBe("批量读取");
	});
	it("父容器优先显示实际失败原因", () => {
		const doc = renderTool({ ...tool, state: "failed", nestedCalls: { complete: true, calls: [{ id: "edit", name: "edit", status: "error", error: "CRLF 换行不匹配" }] } });
		expect(doc.querySelector('[role="alert"]')?.textContent).toBe("CRLF 换行不匹配");
	});
	it.each(["write", "edit"])("%s 保留真实 diff，不把参数伪装成执行结果", name => {
		const value: Activity = { ...tool, state: "completed", nestedCalls: { complete: true, calls: [{ id: "code-1/1", name, status: "ok", arguments: { path: "a.ts" }, output: { kind: "inline", value: { content: [], details: { diff: "-1 old\n+1 new" } } } }] } };
		const doc = parseHTML(renderWithMemory(createElement(ToolActivity, { tool: value }), new Map([["tool:code-1", true], ["nested:code-1/1", true]]))).document;
		expect(doc.querySelector(".diff-block")?.textContent).toContain("+1 new");
	});
	it("运行时展开，源码和输出默认折叠；耗时使用实际记录", () => {
		const doc = renderTool({ ...tool, durationMs: 20 });
		expect(doc.querySelector('.codeact-activity > [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");
		expect(doc.querySelector(".codeact-output")).toBeNull();
		expect(doc.querySelector(".tool-parameters")?.getAttribute("data-state")).toBe("closed");
		expect(doc.querySelector(".codeact-activity .activity-summary")?.textContent).toContain("20 ms");
		expect(doc.querySelector('[data-nested-tool-call-id="code-1/1"] .activity-summary')?.textContent).toContain("10 ms");
		expect(doc.querySelectorAll("[data-tool-call-id]")).toHaveLength(1);
	});
	it("成功收起、失败展开、用户展开状态优先；停止不覆盖已完成子调用", () => {
		expect(renderTool({ ...tool, state: "completed" }).querySelector('[data-slot="collapsible"]')?.getAttribute("data-state")).toBe("closed");
		expect(renderTool({ ...tool, state: "failed" }).querySelector('[data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");
		expect(renderTool({ ...tool, state: "failed" }, false).querySelector('[data-slot="collapsible"]')?.getAttribute("data-state")).toBe("closed");
		const stopped = renderTool({ ...tool, state: "stopped" }, true);
		expect([...stopped.querySelectorAll("[data-nested-tool-call-id]")].map(row => row.getAttribute("data-state"))).toEqual(["completed", "stopped"]);
	});
	it("捕获的子失败不被父成功掩盖，终端控制字符被清理", () => {
		const value: Activity = { ...tool, state: "completed", nestedCalls: { complete: true, calls: [{ id: "code-1/1", name: "read", status: "error", error: "\x1b[31mFile not found\x1b[0m", durationMs: 8 }] } };
		const doc = renderTool(value, true);
		expect(doc.querySelector(".codeact-activity")?.getAttribute("data-state")).toBe("completed");
		expect(doc.querySelector('[role="alert"]')?.textContent).toBe("File not found");
		expect(doc.querySelector('[data-nested-tool-call-id]')?.getAttribute("data-state")).toBe("failed");
	});
});
