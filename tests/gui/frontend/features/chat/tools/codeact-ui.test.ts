import { createElement } from "react";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { GuiSnapshot } from "../../../../../../src/gui/shared/protocol/state.ts";
import { ToolSelection } from "../../../../../../src/gui/frontend/features/chat/tools/tool-selection.tsx";
import { ToolActivity } from "../../../../../../src/gui/frontend/features/chat/tools/tool-activity.tsx";
import type { ToolActivity as Activity } from "../../../../../../src/gui/frontend/features/chat/tools/activity.ts";
import { activityCounts } from "../../../../../../src/gui/frontend/features/chat/tools/activity.ts";
import { ApprovalBar } from "../../../../../../src/gui/frontend/features/chat/tools/approval.tsx";
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

describe("CodeAct 目的、结果与确认", () => {
	it("desc 是标题但不决定成败，真实异常优先于旧的内部失败", () => {
		const doc = renderTool({ ...tool, state: "failed", args: { desc: "检查配置 <script>not html</script>", code: "missing" },
			output: { kind: "inline", value: { content: [{ type: "text", text: "error\nTraceback (most recent call last):\nNameError: missing is not defined" }] } },
			nestedCalls: { complete: true, calls: [{ id: "old-error", name: "read", status: "error", error: "earlier handled failure" }] } });
		expect(doc.querySelector(".activity-label")?.textContent).toBe("检查配置 <script>not html</script>");
		expect(doc.querySelector("script")).toBeNull();
		expect(doc.querySelector('[role="alert"]')?.textContent).toBe("NameError: missing is not defined");
		expect(doc.querySelector(".codeact-activity")?.getAttribute("data-state")).toBe("failed");
	});
	it("生成代码、等待确认与拒绝未执行使用不同状态，纯计算结果可直接看到", () => {
		const preparing = renderTool({ ...tool, state: "preparing", nestedCalls: { complete: true, calls: [] } });
		expect(preparing.querySelector(".activity-summary")?.textContent).toContain("生成代码");
		expect(preparing.querySelector("pre")?.textContent).toContain('read(path="a.ts")');
		expect(preparing.querySelector(".token.string")?.textContent).toBe('"a.ts"');
		const waiting = renderTool({ ...tool, state: "pending", args: { desc: "请求变更", confirmationPending: true } });
		expect(waiting.querySelector(".activity-summary")?.textContent).toContain("等待确认");
		const rejected = renderTool({ ...tool, state: "stopped", durationMs: 0, output: { kind: "inline", value: { content: [], details: { metrics: { outcome: "confirmation_rejected", executed: false } } } } });
		expect(rejected.querySelector(".activity-summary")?.textContent).toContain("已拒绝 · 未执行");
		const completed = renderTool({ ...tool, state: "completed", output: { kind: "inline", value: { content: [{ type: "text", text: "ok\n42" }] } } });
		expect(completed.querySelector(".codeact-overview")?.textContent).toContain("42");
	});
	it.each(["metrics", "nested"])("部分失败来源 %s 不改变 completed 语义，折叠时也有警示", source => {
		const doc = renderTool({ ...tool, name: "execute", state: "completed",
			output: { kind: "inline", value: { content: [{ type: "text", text: "partial_failure\n42\ntool_failures: []" }],
				...(source === "metrics" ? { details: { metrics: { outcome: "tool_partial_failure" } } } : {}) } },
			nestedCalls: { complete: true, calls: source === "nested" ? [{ id: "failed", name: "read", status: "error", error: "missing" }] : [] } });
		expect(doc.querySelector(".activity-summary")?.textContent).toContain("执行完成 · 有内部失败");
		expect(doc.querySelector(".codeact-activity")?.getAttribute("data-state")).toBe("completed");
		expect(doc.querySelector(".codeact-overview")?.textContent).toContain("42");
		expect(doc.querySelector(".codeact-overview")?.textContent).not.toContain("partial_failure");
	});
	it("执行数和内部函数数分开计数", () => {
		expect(activityCounts([tool])).toEqual(["1 次执行", "2 次函数调用"]);
	});
	it("确认条展示目的和真实确认原因，不把待执行源码当 HTML，也不渲染模态弹窗", () => {
		const doc = parseHTML(renderWithMemory(createElement(ApprovalBar, { disabled: false, send: async () => true,
			dialog: { id: "confirm-1", kind: "codeact", title: "检查配置", message: "确认？", options: [], initial: "", deadline: null,
				codeact: { id: "execution-1", cwd: "D:/fixture", code: 'print("<script>not html</script>")', reason: "允许写入 <b>配置</b>？" } } }))).document;
		expect(doc.querySelector("section")?.getAttribute("data-execution-id")).toBe("execution-1");
		expect(doc.querySelector("section")?.textContent).toContain("等待确认 · 尚未执行");
		expect(doc.querySelector(".approval-bar-reason")?.textContent).toBe("允许写入 <b>配置</b>？");
		expect(doc.querySelector("b,script,[role=dialog]")).toBeNull();
		expect(doc.querySelectorAll("button:not([disabled])").length).toBeGreaterThanOrEqual(3);
	});
});

describe("CodeAct 执行容器", () => {
	it("根据实际调用显示操作、目标和次数，不把顺序调用推断为并发", () => {
		const single = renderTool({ ...tool, nestedCalls: { complete: true, calls: [{ id: "read-1", name: "read", status: "ok", arguments: { path: "App.css" } }] } });
		expect(single.querySelector(".activity-label")?.textContent).toBe("读取"); expect(single.querySelector(".activity-target")?.textContent).toBe("App.css");
		const pure = renderTool({ ...tool, args: { code: 'print("read(path=foo)")' }, nestedCalls: { complete: true, calls: [] } });
		expect(pure.querySelector(".activity-label")?.textContent).toBe("代码执行");
		const batch = renderTool({ ...tool, nestedCalls: { complete: true, calls: ["a", "b"].map(id => ({ id, name: "read", status: "ok" })) } });
		expect(batch.querySelector(".activity-label")?.textContent).toBe("读取 · 2 次");
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
	it("运行时展开，源码和输出默认折叠；父子耗时只显示整数毫秒", () => {
		const doc = renderTool({ ...tool, durationMs: 385.7544999999809,
			nestedCalls: { complete: false, calls: [{ id: "code-1/1", name: "find", status: "ok", durationMs: 3.056299999996554 }] } });
		expect(doc.querySelector('.codeact-activity > [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");
		expect(doc.querySelector(".codeact-output")).toBeNull();
		expect(doc.querySelector(".tool-parameters")?.getAttribute("data-state")).toBe("closed");
		expect(doc.querySelector(".codeact-activity .activity-summary")?.textContent).toContain("386 ms");
		expect(doc.querySelector('[data-nested-tool-call-id="code-1/1"] .activity-summary')?.textContent).toContain("3 ms");
		expect(doc.querySelector(".codeact-activity")?.textContent).not.toMatch(/\d+\.\d+ ms/);
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

describe("原生 execute 卡片", () => {
    it.each([
        { desc: "检查配置" },
        { desc: "检查配置", confirm: "是否修改配置？" },
        { desc: "检查配置", confirm: "是否修改配置？", code: "print(" },
    ])("增量参数 %j 先显示目的，确认原因不触发等待确认", args => {
        const doc = renderTool({ id: "streaming-execute", name: "execute", state: "preparing", args, output: undefined });
        expect(doc.querySelector(".activity-label")?.textContent).toBe("检查配置");
        expect(doc.querySelector(".activity-summary")?.textContent).toContain("生成代码");
        expect(doc.querySelector(".activity-summary")?.textContent).not.toContain("等待确认");
        if ("confirm" in args) expect(doc.querySelector(".tool-note")?.textContent).toBe("确认原因：是否修改配置？");
        if ("code" in args) expect(doc.querySelector("pre")?.textContent).toContain("print(");
        else expect(doc.querySelector("pre")).toBeNull();
    });
    it.each(["preparing", "pending", "running", "completed", "failed", "stopped"] as const)("状态 %s 使用 Python 执行容器，保留真实调用身份", state => {
        const doc = renderTool({ ...tool, name: "execute", state,
            args: { code: 'print("中文\\n<script>")', desc: "检查配置", confirmationPending: state === "pending" } });
        expect(doc.querySelector('[data-tool="execute"]')).not.toBeNull();
        expect(doc.querySelectorAll("[data-tool-call-id]")).toHaveLength(1);
        expect(doc.querySelector(".codeact-activity")?.getAttribute("data-state")).toBe(state);
        expect(doc.querySelector("script")).toBeNull();
        if (state === "preparing") expect(doc.querySelector("pre")?.textContent).toContain('print("中文\\n<script>")');
        if (state === "pending") expect(doc.querySelector(".activity-summary")?.textContent).toContain("等待确认");
    });
    it("原生执行不再混入普通工具计数，内部函数单独统计", () => {
        expect(activityCounts([{ ...tool, name: "execute" }])).toEqual(["1 次执行", "2 次函数调用"]);
    });
});
