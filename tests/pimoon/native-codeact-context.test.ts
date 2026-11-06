import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { findPrunableToolCallIds, pruneToolTransactions, applyPersistedToolPruning, PRUNE_STATE } from "../../src/harness/prune/prune.ts";
import { action, fixture } from "./native-fixture.ts";

afterEach(() => vi.unstubAllEnvs());

it("启停内部函数同步目录与 Python，旧代理别名也不能绕过禁用，变量保留", async () => {
    const value = await fixture([
        action("sentinel=42\nsaved_write=write"), { text: "ready" },
        action('assert sentinel==42\nassert "write" not in globals()\nsaved_write(path="denied.txt",content="bad")'), { text: "blocked" },
        action('assert sentinel==42\nwrite(path="enabled.txt",content="once")'), { text: "done" },
    ]);
    try {
        await value.runtime.session.prompt("Initialize.");
        value.runtime.session.setActiveToolsByName(["execute", "read"]);
        await value.runtime.session.prompt("Disabled.");
        expect(value.results().at(-1)?.isError).toBe(true);
        await expect(fs.access(path.join(value.cwd, "denied.txt"))).rejects.toThrow();
        expect(value.server.requests[2]?.tools?.[0]?.function.description).not.toContain("write(path:");
        value.runtime.session.setActiveToolsByName(["execute", "read", "write"]);
        await value.runtime.session.prompt("Enabled.");
        expect(value.results().at(-1)?.isError).toBe(false);
        expect(await fs.readFile(path.join(value.cwd, "enabled.txt"), "utf8")).toBe("once");
        expect(value.server.requests[4]?.tools?.[0]?.function.description).toContain("write(path:");
        expect(value.server.requests.every(request => request.tools?.length === 1 && request.tools[0]?.function.name === "execute")).toBe(true);
    } finally { await value.close(); }
});

it("运行中注册的 codemode 函数在下一轮进入目录与 Python，不变成第二个模型工具", async () => {
    let pi: ExtensionAPI | undefined;
    let calls = 0;
    const extension: InlineExtension = { name: "dynamic-function", factory(api) { pi = api; } };
    const value = await fixture([action("sentinel=42"), { text: "ready" },
        action('assert sentinel==42\nlate_probe(value="新函数")'), { text: "done" }], undefined, [extension], undefined, ["execute", "read", "write", "late_probe"]);
    try {
        await value.runtime.session.prompt("Initialize.");
        if (!pi) throw new Error("缺少扩展接口");
        pi.registerTool({ name: "late_probe", label: "Probe", description: "Late probe.", exposure: "codemode",
            parameters: Type.Object({ value: Type.String() }),
            async execute(_id, args) { calls++; return { content: [{ type: "text", text: args.value }], details: {} }; } });
        await value.runtime.session.prompt("Call new function.");
        expect(value.results().at(-1)?.isError).toBe(false);
        expect(calls).toBe(1);
        expect(value.server.requests[2]?.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
        expect(value.server.requests[2]?.tools?.[0]?.function.description).toContain("late_probe(value:");
        expect(value.results().at(-1)?.nestedCalls?.calls[0]?.name).toBe("late_probe");
    } finally { await value.close(); }
});

it("裁剪候选与旧检查点均保留 execute 源码和结果，下一轮变量不重放", async () => {
    const value = await fixture([action('sentinel=42\nwrite(path="once.txt",content="once")\n"x"*5000'), { text: "ready" },
        action('assert sentinel==42\nread(path="once.txt",mode="raw")'), { text: "done" }]);
    try {
        await value.runtime.session.prompt("Initialize.");
        const messages = value.runtime.session.messages;
        const original = JSON.stringify(messages);
        const id = value.results()[0]?.toolCallId;
        if (!id) throw new Error("缺少结果");
        expect(findPrunableToolCallIds(messages).has(id)).toBe(false);
        const pruned = pruneToolTransactions(messages, new Set([id]));
        expect(pruned.removedToolCalls).toBe(0);
        expect(pruned.removedToolResults).toBe(0);
        expect(JSON.stringify(pruned.messages)).toBe(original);
        value.runtime.session.sessionManager.appendCustomEntry(PRUNE_STATE,
            { operation: "prune", toolCallIds: [id], previousToolCallIds: [] });
        expect(applyPersistedToolPruning(messages, value.runtime.session.sessionManager.getBranch())).toEqual(messages);
        const previous = value.runtime.session.agent.transformContext;
        value.runtime.session.agent.transformContext = async (input, signal) => {
            const projected = previous ? await previous(input, signal) : input;
            return applyPersistedToolPruning(projected, value.runtime.session.sessionManager.getBranch());
        };
        await value.runtime.session.prompt("Continue without repeating.");
        expect(value.results()).toHaveLength(2);
        expect(value.results().at(-1)?.isError).toBe(false);
        expect(value.server.requests[2]?.messages.some(message => message.role === "tool" && message.tool_call_id === id)).toBe(true);
        expect(await fs.readFile(path.join(value.cwd, "once.txt"), "utf8")).toBe("once");
    } finally { await value.close(); }
});

it("普通查询工具仍可整笔裁剪，混合 execute ID 不会误删执行来源", async () => {
    const value = await fixture([action("42"), { text: "done" }]);
    try {
        await value.runtime.session.prompt("Fixture.");
        const original = value.runtime.session.messages;
        const executionId = value.results()[0]?.toolCallId;
        const model = original.find(message => message.role === "assistant");
        if (!model || !executionId) throw new Error("缺少消息");
        const messages = [...original,
            { ...model, content: [{ type: "toolCall" as const, id: "ordinary", name: "read", arguments: { path: "file" } }] },
            { role: "toolResult" as const, toolCallId: "ordinary", toolName: "read", isError: false, content: [{ type: "text" as const, text: "query" }], timestamp: 1 }];
        expect(findPrunableToolCallIds(messages)).toEqual(new Set(["ordinary"]));
        const result = pruneToolTransactions(messages, new Set(["ordinary", executionId]));
        expect(result.removedToolCalls).toBe(1);
        expect(result.removedToolResults).toBe(1);
        expect(result.messages).toEqual(original);
    } finally { await value.close(); }
});

it("真实摘要请求压缩原生会话后保留 Python 状态，继续执行不重放写入", async () => {
    const value = await fixture([
        action('sentinel=42\nwrite(path="once.txt",content="once")'), { text: "initialized" },
        { text: "状态已确认，准备压缩。" },
        { text: "已写入 once.txt，Python sentinel=42；不要重放写入，下一步读取确认。" },
        { text: "当前轮状态已确认；sentinel=42，禁止重放写入。" },
        action('assert sentinel==42\nread(path="once.txt",mode="raw")'), { text: "verified" },
    ]);
    try {
        await value.runtime.session.prompt("Initialize once.");
        await value.runtime.session.prompt("Keep the completed work.");
        value.runtime.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
        const summary = await value.runtime.session.compact("保留已完成写入和 Python 状态说明，不重放。");
        expect(summary.summary).toContain("sentinel");
        expect(value.runtime.session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
        await value.runtime.session.prompt("Continue without repeating.");
        expect(value.results().at(-1)?.isError).toBe(false);
        expect(await fs.readFile(path.join(value.cwd, "once.txt"), "utf8")).toBe("once");
        const last = value.server.requests.at(-1);
        expect(last?.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
        const requestText = JSON.stringify(value.server.requests[3]);
        expect(requestText).toContain("sentinel");
        // 对任何保留的工具结果，模型请求内都有对应调用，不能出现孤儿结果。
        for (const request of value.server.requests.slice(5)) {
            const payload = JSON.stringify(request.messages);
            for (const message of request.messages.filter(item => item.role === "tool"))
                expect(payload).toContain(`"id":"${message.tool_call_id}"`);
        }
    } finally { await value.close(); }
});

it("同名内部函数定义更新后下一轮采用新参数与实现，旧代理仍经宿主 schema 校验", async () => {
    let pi: ExtensionAPI | undefined;
    let current = "old";
    const seen: string[] = [];
    const extension: InlineExtension = { name: "replace-function", factory(api) {
        pi = api;
        api.registerTool({ name: "probe", label: "Probe", description: "Old probe.", exposure: "codemode",
            parameters: Type.Object({ old: Type.String() }),
            async execute(_id, args) { seen.push(args.old); return { content: [{ type: "text", text: current }], details: {} }; } });
    } };
    const value = await fixture([action('saved_probe=probe\nprobe(old="first")'), { text: "ready" },
        action('probe(new="second")'), { text: "updated" },
        action('saved_probe(old="must reject")'), { text: "blocked" }],
        undefined, [extension], undefined, ["execute", "probe"]);
    try {
        await value.runtime.session.prompt("Old.");
        if (!pi) throw new Error("缺少扩展接口");
        current = "new";
        pi.registerTool({ name: "probe", label: "Probe", description: "New probe.", exposure: "codemode",
            parameters: Type.Object({ new: Type.String() }, { additionalProperties: false }),
            async execute(_id, args) { seen.push(args.new); return { content: [{ type: "text", text: current }], details: {} }; } });
        await value.runtime.session.prompt("New.");
        expect(value.results().at(-1)?.isError).toBe(false);
        expect(value.server.requests[2]?.tools?.[0]?.function.description).toContain("probe(new:");
        await value.runtime.session.prompt("Old alias.");
        expect(value.results().at(-1)?.isError).toBe(true);
        expect(seen).toEqual(["first", "second"]);
    } finally { await value.close(); }
});

it("同一代码块执行中撤销函数权限，后续旧快照调用仍被宿主拒绝", async () => {
    let reached: (() => void) | undefined;
    let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const extension: InlineExtension = { name: "gate", factory(pi) {
        pi.registerTool({ name: "gate", label: "Gate", description: "Wait.", exposure: "codemode", parameters: Type.Object({}),
            async execute() { reached?.(); await gate; return { content: [], details: {} }; } });
    } };
    const value = await fixture([action('gate()\nwrite(path="revoked.txt",content="bad")'), { text: "blocked" }],
        undefined, [extension], undefined, ["execute", "write", "gate"]);
    try {
        const running = value.runtime.session.prompt("Fixture.");
        await entered;
        value.runtime.session.setActiveToolsByName(["execute"]);
        release?.();
        await running;
        await expect(fs.access(path.join(value.cwd, "revoked.txt"))).rejects.toThrow();
        expect(value.results().at(-1)?.isError).toBe(true);
    } finally { release?.(); await value.close(); }
});

it("压缩后重开明确提示状态丢失，不重放写入，原生调用仍成对", async () => {
    const first = await fixture([action('sentinel=42\nwrite(path="once.txt",content="once")'), { text: "ready" },
        { text: "准备压缩。" }, { text: "已写入 once.txt，sentinel=42，不要重放。" }, { text: "保留已完成工作。" }]);
    let sessionFile: string | undefined;
    try {
        await first.runtime.session.prompt("Initialize.");
        await first.runtime.session.prompt("Keep history.");
        first.runtime.services.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
        await first.runtime.session.compact();
        sessionFile = first.runtime.session.sessionManager.getSessionFile();
    } finally { await first.close(); }
    if (!sessionFile) throw new Error("缺少会话文件");
    const next = await fixture([action('assert "sentinel" not in globals()\nread(path="once.txt",mode="raw")'), { text: "done" }],
        undefined, [], { root: first.root, sessionFile });
    try {
        await next.runtime.session.prompt("Continue without replay.");
        expect(next.results().at(-1)?.isError).toBe(false);
        expect(JSON.stringify(next.server.requests[0])).toContain("Python 内存为空");
        expect(await fs.readFile(path.join(next.cwd, "once.txt"), "utf8")).toBe("once");
        expect(next.server.requests[0]?.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
    } finally { await next.close(); }
});

it("旧文本结果被压缩隐藏后仍拒绝进入原生执行，不由摘要抹掉协议边界", async () => {
    const value = await fixture([action('write(path="must-not-run.txt",content="bad")'), { text: "done" }]);
    try {
        const manager = value.runtime.session.sessionManager;
        manager.appendCustomMessageEntry("codeact_result", "old execution", false);
        manager.appendCompaction("旧会话执行过代码。", null, 1000);
        await value.runtime.session.prompt("Continue.");
        await expect(fs.access(path.join(value.cwd, "must-not-run.txt"))).rejects.toThrow();
        expect(value.server.requests).toHaveLength(0);
        expect(JSON.stringify(value.runtime.session.messages)).toContain("原生执行请新建会话");
    } finally { await value.close(); }
});
