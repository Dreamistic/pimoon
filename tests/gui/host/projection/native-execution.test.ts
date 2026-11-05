import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@earendil-works/pi-ai";
import { GuiHistory } from "../../../../src/gui/host/projection/history.ts";
import { GuiPayloads } from "../../../../src/gui/host/projection/payloads.ts";
import { GuiStream } from "../../../../src/gui/host/projection/stream.ts";
import { GuiLiveTools } from "../../../../src/gui/host/projection/live-tools.ts";
import { NESTED_MUTATION_ENTRY } from "../../../../src/gui/host/projection/nested-mutations.ts";
import { transcriptReplies } from "../../../../src/gui/frontend/features/chat/transcript/transcript-replies.ts";
import { assistant, source } from "../../helpers/transcript-fixtures.ts";

const call: ToolCall = { type: "toolCall", id: "native-1", name: "execute", arguments: { code: 'print("中文")', desc: "检查" } };

it("流式参数快照、确认进度、执行和历史只有一个根卡片", () => {
    const payloads = new GuiPayloads(), stream = new GuiStream(payloads), live = new GuiLiveTools(payloads);
    const partial = assistant([{ ...call, arguments: {} }], "pending");
    stream.start(partial);
    stream.update({ type: "toolcall_start", contentIndex: 0, partial });
    const empty = stream.project();
    partial.content[0] = { ...call, arguments: { code: 'print("中' } };
    stream.update({ type: "toolcall_delta", contentIndex: 0, delta: '{"code":"print(\\"中', partial });
    const rows = transcriptReplies({ ...source({ streaming: true }), streamingMessage: stream.project() });
    const preparing = rows.flatMap(row => row.kind === "reply" ? row.process : []).filter(item => item.kind === "tool");
    expect(preparing).toHaveLength(1);
    expect(preparing[0]?.tool).toMatchObject({ id: call.id, name: "execute", state: "preparing", args: { code: 'print("中' } });
    expect(empty?.role === "assistant" && empty.content[0]).toMatchObject({ arguments: {} });
    partial.content[0] = call;
    stream.update({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
    const final = assistant([call], "toolUse");
    const tools = () => transcriptReplies(source({ messages: [final], liveTools: live.project(), streaming: true }))
        .flatMap(row => row.kind === "reply" ? row.process : []).filter(item => item.kind === "tool");
    live.accept({ type: "tool_execution_start", toolCallId: call.id, toolName: "execute", args: call.arguments });
    live.accept({ type: "tool_execution_update", toolCallId: call.id, toolName: "execute", args: call.arguments,
        partialResult: { content: [], details: { confirmationPending: true } } });
    expect(tools()[0]?.tool).toMatchObject({ state: "pending", args: { confirmationPending: true, desc: "检查" } });
    live.accept({ type: "tool_execution_update", toolCallId: call.id, toolName: "execute", args: call.arguments,
        partialResult: { content: [], details: { confirmationPending: false } } });
    expect(tools()).toHaveLength(1);
    expect(tools()[0]?.tool.state).toBe("running");
});

it.each(["cancelled", "python_error", "confirmation_rejected"])("大输出历史保留 %s 状态、图片与内部 diff，不当作正常结束", outcome => {
    const payloads = new GuiPayloads(), manager = SessionManager.inMemory();
    manager.appendMessage(assistant([call], "toolUse"));
    manager.appendCustomEntry(NESTED_MUTATION_ENTRY, { toolCallId: `${call.id}/1`, toolName: "edit", diff: "-1 old\n+1 new" });
    manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: "execute", timestamp: 2, isError: true,
        content: [{ type: "text", text: "x".repeat(80000) }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        details: { metrics: { outcome, ...(outcome === "confirmation_rejected" ? { executed: false } : {}) } },
        nestedCalls: { complete: true, calls: [{ id: `${call.id}/1`, name: "edit", status: "ok" }] } });
    const messages = new GuiHistory(payloads).project(manager).entries.flatMap(entry => entry.messages);
    const rows = transcriptReplies({ ...source({}), messages });
    const reply = rows.find(row => row.kind === "reply");
    if (reply?.kind !== "reply") throw new Error("缺少回复");
    expect(reply.state).toBe(outcome === "python_error" ? "failed" : "stopped");
    const tools = reply.process.filter(item => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool.nestedCalls?.calls[0]?.output).toMatchObject({ kind: "inline", value: { details: { diff: "-1 old\n+1 new" } } });
    const output = tools[0]?.tool.output;
    if (output?.kind !== "reference") throw new Error("缺少大输出引用");
    expect(payloads.toolOutput(output.id).content).toEqual([{ type: "text", text: "x".repeat(80000) },
        { type: "image", mimeType: "image/png", imageId: expect.any(String) }]);
});
