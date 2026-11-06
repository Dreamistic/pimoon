import fs from "node:fs/promises";
import path from "node:path";
import { analyzeExecution } from "../../src/harness/telemetry-report/analyzers/execution.ts";
import { registerTelemetry, type TelemetryService } from "../../src/harness/telemetry/service.ts";
import { transcriptReplies } from "../../src/gui/frontend/features/chat/transcript/transcript-replies.ts";
import { source } from "../gui/helpers/transcript-fixtures.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { GuiLiveTools } from "../../src/gui/host/projection/live-tools.ts";
import { GuiPayloads } from "../../src/gui/host/projection/payloads.ts";
import { GuiStream } from "../../src/gui/host/projection/stream.ts";
import { GuiDialogs } from "../../src/gui/host/session/dialogs.ts";

afterEach(() => vi.unstubAllEnvs());
import { action, marker, fixture } from "./native-fixture.ts";

it("模型仅见 execute；Python 状态、多轮结果和内部审批调用身份保留", async () => {
    const value = await fixture([action('value=41\nvalue'), { text: "initialized" },
        action('value+=1\nwrite(path="answer.txt",content=str(value))\nvalue'), { text: "done" }]);
    try {
        await value.runtime.session.prompt("Initialize.");
        const failure = value.runtime.session.messages.find(message => message.role === "assistant" && message.stopReason === "error");
        if (failure) throw new Error(JSON.stringify(failure));
        await value.runtime.session.prompt("Write once.");
        expect(await fs.readFile(path.join(value.cwd, "answer.txt"), "utf8")).toBe("42");
        expect(value.results()).toHaveLength(2);
        expect(value.results().every(result => !result.isError)).toBe(true);
        for (const request of value.server.requests) {
            expect(request.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
            const schema = request.tools?.[0]?.function.parameters;
            if (!schema || typeof schema !== "object" || !("properties" in schema)
                || !schema.properties || typeof schema.properties !== "object") throw new Error("缺少 execute 参数声明");
            expect(Object.keys(schema.properties)).toEqual(["desc", "confirm", "code"]);
            expect(JSON.stringify(request)).not.toContain("<execute_result");
        }
        const last = value.server.requests.at(-1);
        expect(last?.messages.some(message => message.role === "tool" && message.tool_call_id)).toBe(true);
        expect(value.results().at(-1)?.nestedCalls?.calls.map(call => call.name)).toEqual(["write"]);
    } finally { await value.close(); }
});

it("确认批准后执行一次，拒绝和无确认入口均不写入", async () => {
    for (const decision of ["approved", "rejected", "unavailable"] as const) {
        let confirmations = 0;
        const value = await fixture([action(marker, "是否新增标记？"), { text: "done" }],
            decision === "unavailable" ? undefined : async () => { confirmations++; return { kind: decision }; });
        try {
            await value.runtime.session.prompt("Fixture.");
            expect(confirmations).toBe(decision === "unavailable" ? 0 : 1);
            expect(value.results()).toHaveLength(1);
            if (decision === "approved") expect(await fs.readFile(path.join(value.cwd, "marker.txt"), "utf8")).toBe("once");
            else {
                await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
                expect(value.results()[0]?.isError).toBe(true);
            }
        } finally { await value.close(); }
    }
});

it("整块批准不能绕过内部工具拒绝，SDK 记录真实 nestedCalls", async () => {
    const guard: InlineExtension = { name: "deny-write", factory(pi) {
        pi.on("tool_call", event => event.toolName === "write" ? { block: true, reason: "fixture denied" } : undefined);
    } };
    const value = await fixture([action('write(path="marker.txt",content="bad")', "确认写入？"), { text: "done" }],
        async () => ({ kind: "approved" }), [guard]);
    try {
        await value.runtime.session.prompt("Fixture.");
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.results()[0]?.isError).toBe(true);
        expect(JSON.stringify(value.results()[0])).toContain("fixture denied");
    } finally { await value.close(); }
});

it("等待确认期间取消，不接受迟到批准，不执行", async () => {
    const ui = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
    const value = await fixture([action(marker, "确认？")], (request, signal) => ui.confirmCodeAct(request, signal));
    try {
        const running = value.runtime.session.prompt("Fixture.");
        await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
        const id = ui.list()[0]?.id ?? "";
        await value.runtime.session.abort();
        await running;
        expect(ui.list()).toEqual([]);
        expect(() => ui.respond(id, "yes")).toThrow();
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.server.requests).toHaveLength(1);
    } finally { await value.close(); }
});

it("模型直接调用隐藏内部函数被拒绝", async () => {
    const value = await fixture([{ tool: "write", args: { path: "marker.txt", content: "bad" } }]);
    try {
        await value.runtime.session.prompt("Fixture.");
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.server.requests).toHaveLength(1);
    } finally { await value.close(); }
});

it("递归 execute 不进入 Python 函数目录", async () => {
    const value = await fixture([action('execute(code="42",desc="nested")'), { text: "done" }]);
    try {
        await value.runtime.session.prompt("Fixture.");
        expect(value.results()[0]?.isError).toBe(true);
        expect(JSON.stringify(value.results()[0]?.content)).toContain("execute");
        expect(value.server.requests[0]?.tools?.[0]?.function.description).not.toContain("execute(code:");
    } finally { await value.close(); }
});

/** 只替换一次供应商终态，执行仍走真实 AgentSession 调度。 */
function replyOnce(value: Awaited<ReturnType<typeof fixture>>, reason: "toolUse" | "length" | "error" | "aborted", calls: number) {
    const provider = value.runtime.session.agent.streamFunction;
    let sent = false;
    value.runtime.session.agent.streamFunction = (model, context, options) => {
        if (sent) return provider(model, context, options);
        sent = true;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
            role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            stopReason: reason, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            content: Array.from({ length: calls }, (_, index) => ({ type: "toolCall", id: `candidate-${index}`,
                name: "execute", arguments: { code: marker, desc: "隔离验证" } })),
        };
        stream.push({ type: "start", partial: message });
        if (reason === "error" || reason === "aborted") stream.push({ type: "error", reason, error: message });
        else stream.push({ type: "done", reason, message });
        stream.end();
        return stream;
    };
}

it("同轮两个 execute 在任何代码启动前全部拒绝", async () => {
    const value = await fixture([]);
    try {
        replyOnce(value, "toolUse", 2);
        await value.runtime.session.prompt("Fixture.");
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.results()).toHaveLength(2);
        expect(value.results().every(result => result.isError)).toBe(true);
        expect(value.server.requests).toHaveLength(0);
    } finally { await value.close(); }
});

it.each(["length", "error", "aborted"] as const)("完整参数但终态 %s 不执行", async reason => {
    const value = await fixture([]);
    try {
        replyOnce(value, reason, 1);
        await value.runtime.session.prompt("Fixture.");
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.results()).toHaveLength(reason === "length" ? 1 : 0);
        if (reason === "length") expect(value.results()[0]?.isError).toBe(true);
    } finally { await value.close(); }
});

it("运行中取消保留已写入文件，不执行后项、不自动重试", async () => {
    const value = await fixture([action(marker + '\nimport time\ntime.sleep(30)\nPath("late.txt").write_text("bad")')]);
    try {
        const running = value.runtime.session.prompt("Fixture.");
        await vi.waitFor(async () => expect(await fs.readFile(path.join(value.cwd, "marker.txt"), "utf8")).toBe("once"), { timeout: 5000 });
        await value.runtime.session.abort();
        await running;
        await expect(fs.access(path.join(value.cwd, "late.txt"))).rejects.toThrow();
        expect(await fs.readFile(path.join(value.cwd, "marker.txt"), "utf8")).toBe("once");
        expect(value.server.requests).toHaveLength(1);
        expect(value.results()).toHaveLength(1);
        expect(value.results()[0]?.isError).toBe(true);
    } finally { await value.close(); }
});

it("持久化重开保留调用结果与单工具投影，清楚提醒 Python 状态丢失，不重放写入", async () => {
    const first = await fixture([action(marker + "\nsentinel=42"), { text: "done" }]);
    let sessionFile: string | undefined;
    try {
        await first.runtime.session.prompt("Fixture.");
        sessionFile = first.runtime.session.sessionManager.getSessionFile();
        expect(sessionFile).toBeTruthy();
    } finally { await first.close(); }
    if (!sessionFile) throw new Error("没有会话文件");
    const next = await fixture([action('assert "sentinel" not in globals()\nread(path="marker.txt",mode="raw")'), { text: "done" }],
        undefined, [], { root: first.root, sessionFile });
    try {
        await next.runtime.session.prompt("Continue without replay.");
        expect(next.results()).toHaveLength(2);
        expect(next.results().at(-1)?.isError).toBe(false);
        expect(await fs.readFile(path.join(next.cwd, "marker.txt"), "utf8")).toBe("once");
        expect(JSON.stringify(next.server.requests[0])).toContain("Python 内存为空");
        expect(next.server.requests[0]?.tools?.map(tool => tool.function.name)).toEqual(["execute"]);
        expect(next.server.requests[0]?.messages.some(message => message.role === "tool")).toBe(true);
    } finally { await next.close(); }
});

it("原生生命周期被 GUI 投影为一个根执行和一个内部调用，不重复完成", async () => {
    const value = await fixture([action('write(path="marker.txt",content="once")'), { text: "done" }]);
    const live = new GuiLiveTools(new GuiPayloads());
    const unsubscribe = value.runtime.session.subscribe(event => {
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") live.accept(event);
    });
    try {
        await value.runtime.session.prompt("Fixture.");
        expect(live.project()).toHaveLength(1);
        expect(live.project()[0]).toMatchObject({ toolName: "execute", completion: { isError: false },
            nestedCalls: { calls: [{ name: "write", status: "ok" }] } });
        expect(live.size).toBe(0);
    } finally { unsubscribe(); await value.close(); }
});

it("JSON 解码保留 Unicode、引号、反斜线和旧 XML 标记，不二次反转义", async () => {
    const payload = '中文😀 "quoted" \\n <' + '/execute>';
    const code = `value=${JSON.stringify(payload)}\nwrite(path="payload.txt",content=value)\nvalue`;
    const value = await fixture([action(code), { text: "done" }]);
    try {
        await value.runtime.session.prompt("Fixture.");
        expect(await fs.readFile(path.join(value.cwd, "payload.txt"), "utf8")).toBe(payload);
        expect(value.results()[0]?.isError).toBe(false);
    } finally { await value.close(); }
});

it.each([
    { code: marker, desc: "" },
    { code: " ", desc: "空源码" },
    { code: marker, desc: "未知参数", extra: true },
    { code: marker, desc: "空确认", confirm: " " },
])("无效原生参数不执行：%j", async args => {
    const value = await fixture([{ tool: "execute", args }, { text: "done" }]);
    try {
        await value.runtime.session.prompt("Fixture.");
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.results()[0]?.isError).toBe(true);
    } finally { await value.close(); }
});

it("确认期间上下文改变使批准失效，不执行旧代码", async () => {
    const ui = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
    const value = await fixture([action(marker, "确认？"), { text: "done" }], (request, signal) => ui.confirmCodeAct(request, signal));
    try {
        const running = value.runtime.session.prompt("Fixture.");
        await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
        value.runtime.session.sessionManager.appendCustomEntry("context-changed", {});
        ui.respond(ui.list()[0]?.id ?? "", "yes");
        await running;
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(JSON.stringify(value.results()[0])).toContain("confirmation_invalidated");
    } finally { await value.close(); }
});

it("旧文本执行历史明确拒绝继续，不伪造原生调用身份", async () => {
    const value = await fixture([]);
    try {
        value.runtime.session.sessionManager.appendCustomMessageEntry("codeact_result", "old result", false);
        await value.runtime.session.prompt("Fixture.");
        expect(value.server.requests).toHaveLength(0);
        expect(JSON.stringify(value.runtime.session.messages)).toContain("原生执行请新建会话");
    } finally { await value.close(); }
});

it("真实确认进度进入 GUI 等待态，批准后清除，不改写模型参数", async () => {
    const ui = new GuiDialogs(() => {}, () => 0, { get: () => "", set: () => {} });
    const value = await fixture([action(marker, "确认？"), { text: "done" }], (request, signal) => ui.confirmCodeAct(request, signal));
    const live = new GuiLiveTools(new GuiPayloads());
    const unsubscribe = value.runtime.session.subscribe(event => {
        if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") live.accept(event);
    });
    const tools = () => transcriptReplies(source({ messages: value.runtime.session.messages, liveTools: live.project(), streaming: true }))
        .flatMap(row => row.kind === "reply" ? row.process : []).filter(item => item.kind === "tool");
    try {
        const running = value.runtime.session.prompt("Fixture.");
        await vi.waitFor(() => expect(ui.list()).toHaveLength(1));
        expect(tools()).toHaveLength(1);
        expect(tools()[0]?.tool).toMatchObject({ name: "execute", state: "pending", args: { confirmationPending: true } });
        ui.respond(ui.list()[0]?.id ?? "", "yes");
        await running;
        expect(tools()[0]?.tool.state).toBe("completed");
        const assistant = value.runtime.session.messages.find(message => message.role === "assistant");
        expect(JSON.stringify(assistant)).not.toContain("confirmationPending");
        expect(JSON.stringify(value.server.requests)).not.toContain("confirmationPending");
    } finally { unsubscribe(); await value.close(); }
});

it.each(["success", "python_error", "confirmation_rejected"] as const)("原生 %s 只记录一个执行根，结构化事实不丢失、不保存源码", async outcome => {
    let telemetry: TelemetryService | undefined;
    const probe: InlineExtension = { name: "native-telemetry", factory(pi) { telemetry = registerTelemetry(pi); } };
    const code = outcome === "python_error" ? 'secret_marker="SYNTHETIC_PRIVATE_PAYLOAD"\n1/0' : 'secret_marker="SYNTHETIC_PRIVATE_PAYLOAD"\n42';
    const value = await fixture([action(code, outcome === "confirmation_rejected" ? "确认？" : undefined), { text: "done" }],
        async () => ({ kind: "rejected" }), [probe]);
    try {
        await value.runtime.session.prompt("Fixture.");
        if (!telemetry) throw new Error("未创建遥测");
        await telemetry.onSessionShutdown({ type: "session_shutdown", reason: "quit" });
        const snapshot = telemetry.snapshot();
        const calls = snapshot.records.filter(record => record.type === "call");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ tool: "execute", fields: { outcome } });
        expect(snapshot.pending_calls).toBe(0);
        expect(analyzeExecution(calls).codeact).toMatchObject({ calls: 1, outcomes: { [outcome]: 1 } });
        expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC_PRIVATE_PAYLOAD");
        expect(calls.some(call => call.tool === "codeact")).toBe(false);
    } finally { await value.close(); }
});

it("真实 SSE 先投影目的和确认原因，再预览代码，正常终态并确认后才写入一次", async () => {
    const code = 'from pathlib import Path\nPath("streamed.txt").write_text("中文\\\\n\\"ok\\"", encoding="utf-8")';
    const args = { desc: "流式代码", confirm: "是否写入文件？", code };
    const json = JSON.stringify(args), confirmStart = json.indexOf(',"confirm"'), codeStart = json.indexOf(',"code"'), split = json.indexOf("write_text") + 5;
    let confirmations = 0, executed = 0;
    const value = await fixture([{ tool: "execute", args,
        argumentChunks: [json.slice(0, confirmStart), json.slice(confirmStart, codeStart), json.slice(codeStart, split), json.slice(split)],
        intervalMs: 100 }, { text: "done" }], async () => { confirmations++; return { kind: "approved" }; });
    const stream = new GuiStream(new GuiPayloads());
    const previews: unknown[] = [];
    const probes: Promise<void>[] = [];
    const unsubscribe = value.runtime.session.subscribe(event => {
        if (event.type === "message_start") stream.start(event.message);
        if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") stream.update(update);
            if (update.type === "toolcall_delta") {
                const projected = stream.project();
                if (projected?.role === "assistant") previews.push(structuredClone(projected.content));
                expect(executed).toBe(0);
                expect(confirmations).toBe(0);
                probes.push(fs.access(path.join(value.cwd, "streamed.txt")).then(() => { throw new Error("参数生成期间已写入"); }, () => {}));
            }
        }
        if (event.type === "tool_execution_start" && !event.parentToolCallId) executed++;
    });
    try {
        await value.runtime.session.prompt("Fixture.");
        await Promise.all(probes);
        expect(previews).toHaveLength(4);
        expect(previews[0]).toEqual([expect.objectContaining({ name: "execute", arguments: { desc: args.desc } })]);
        expect(previews[1]).toEqual([expect.objectContaining({ arguments: { desc: args.desc, confirm: args.confirm } })]);
        expect(previews[2]).toEqual([expect.objectContaining({ arguments: { desc: args.desc, confirm: args.confirm, code: expect.stringContaining("write") } })]);
        expect(previews[3]).toEqual([expect.objectContaining({ arguments: args })]);
        expect(confirmations).toBe(1);
        expect(executed).toBe(1);
        expect(await fs.readFile(path.join(value.cwd, "streamed.txt"), "utf8")).toBe('中文\\n"ok"');
        expect(value.results()[0]?.isError).toBe(false);
    } finally { unsubscribe(); await value.close(); }
});

it("真实 SSE 半截参数以 length 收尾不执行，保留未执行错误", async () => {
    const args = { code: marker, desc: "截断" };
    const value = await fixture([{ tool: "execute", args, argumentChunks: [JSON.stringify(args).slice(0, -2)], finishReason: "length" }, { text: "done" }]);
    try {
        await value.runtime.session.prompt("Fixture.");
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.results()[0]?.isError).toBe(true);
        expect(JSON.stringify(value.results()[0])).toContain("not executed");
    } finally { await value.close(); }
});

it("真实 SSE 参数流中取消不执行，不把部分代码补成完整调用", async () => {
    const args = { code: marker, desc: "取消生成" };
    const json = JSON.stringify(args);
    const value = await fixture([{ tool: "execute", args, argumentChunks: [json.slice(0, 25), json.slice(25)], intervalMs: 150 }]);
    let cancelled = false;
    const unsubscribe = value.runtime.session.subscribe(event => {
        if (!cancelled && event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
            cancelled = true;
            void value.runtime.session.abort();
        }
    });
    try {
        await value.runtime.session.prompt("Fixture.");
        expect(cancelled).toBe(true);
        await expect(fs.access(path.join(value.cwd, "marker.txt"))).rejects.toThrow();
        expect(value.results()).toHaveLength(0);
    } finally { unsubscribe(); await value.close(); }
});
