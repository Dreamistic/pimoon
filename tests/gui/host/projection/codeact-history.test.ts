import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GuiHistory } from "../../../../src/gui/host/projection/history.ts";
import { GuiPayloads } from "../../../../src/gui/host/projection/payloads.ts";
import { NESTED_MUTATION_ENTRY } from "../../../../src/gui/host/projection/nested-mutations.ts";
import { CODEACT_RESULT, type CodeActMessage } from "../../../../src/pimoon/codeact/types.ts";
import { assistant, source } from "../../helpers/transcript-fixtures.ts";
import { GuiLiveTools } from "../../../../src/gui/host/projection/live-tools.ts";
import { transcriptReplies } from "../../../../src/gui/frontend/features/chat/transcript/transcript-replies.ts";

it("自定义 CodeAct 结果恢复真实 diff、图片引用与大输出，不生成工具消息", () => {
	const manager = SessionManager.inMemory(), payloads = new GuiPayloads();
	const message: CodeActMessage = { ...assistant([{ type: "text", text: 'edit(path="a.ts",edits=[])' }], "stop"), codeact: { id: "code-1", index: 0, complete: true } };
	manager.appendMessage(message);
	manager.appendCustomEntry(NESTED_MUTATION_ENTRY, { toolCallId: "code-1/1", toolName: "edit", diff: "-1 old\n+1 new" });
	const text = "完整结果".repeat(20_000);
	manager.appendCustomMessageEntry(CODEACT_RESULT, [{ type: "text", text }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], false,
		{ id: "code-1", isError: false, durationMs: 12, metrics: {}, nestedCalls: { complete: true, calls: [{ id: "code-1/1", name: "edit", status: "ok", arguments: { path: "a.ts" } }] } });
	const messages = new GuiHistory(payloads).project(manager).entries.flatMap(entry => entry.messages);
	const result = messages.find(message => message.role === "custom" && message.customType === CODEACT_RESULT);
	if (result?.role !== "custom" || result.output?.kind !== "reference") throw new Error("缺少 CodeAct 输出引用");
	expect(result.content).toEqual([]);
	expect(result.nestedCalls?.calls[0]?.output).toMatchObject({ kind: "inline", value: { details: { diff: "-1 old\n+1 new" } } });
	const output = payloads.toolOutput(result.output.id);
	expect(output.content).toEqual([{ type: "text", text }, { type: "image", mimeType: "image/png", imageId: expect.any(String) }]);
	expect(messages.some(message => message.role === "toolResult")).toBe(false);
	expect(message.content.some(part => part.type === "toolCall")).toBe(false);
});
it.each(["cancelled", "python_error"])("Python 执行阶段的 %s 不因模型已自然结束而显示为正常完成", outcome => {
	const message: CodeActMessage = { ...assistant([{ type: "text", text: "operation()" }], "stop"), codeact: { id: "code-1", index: 0, complete: true } };
	const rows = transcriptReplies(source({ messages: [
		{ role: "user", content: "Run fixture", timestamp: 1 }, message,
		{ role: "custom", customType: CODEACT_RESULT, content: [{ type: "text", text: "error" }], display: false, timestamp: 2,
			details: { id: "code-1", isError: true, durationMs: 20, metrics: { outcome } } },
	] }));
	const reply = rows.find(row => row.kind === "reply");
	expect(reply?.kind === "reply" && reply.state).toBe(outcome === "cancelled" ? "stopped" : "failed");
});

it("生成、待确认、执行和拒绝历史始终投影为同一个执行卡片", () => {
	const payloads = new GuiPayloads(), live = new GuiLiveTools(payloads);
	const message: CodeActMessage = { ...assistant([{ type: "text", text: "write()" }], "stop"), codeact: { id: "confirmed-1", index: 0, complete: true, desc: "检查配置", confirm: "允许修改？" } };
	const input = () => source({ messages: [{ role: "user", content: "test", timestamp: 1 }, message], liveTools: live.project(), streaming: true });
	const tool = () => transcriptReplies(input()).flatMap(row => row.kind === "reply" ? row.process : []).filter(item => item.kind === "tool");
	live.accept({ type: "tool_execution_start", toolCallId: "confirmed-1", toolName: "codeact", args: { code: "write()", desc: "检查配置", confirm: "允许修改？", confirmationPending: true } });
	expect(tool()).toHaveLength(1); expect(tool()[0]?.tool.state).toBe("pending");
	live.accept({ type: "tool_execution_update", toolCallId: "confirmed-1", toolName: "codeact", args: { code: "write()", desc: "检查配置" }, partialResult: { content: [] } });
	expect(tool()[0]?.tool.state).toBe("running");
	const manager = SessionManager.inMemory(); manager.appendMessage(message);
	manager.appendCustomMessageEntry(CODEACT_RESULT, [{ type: "text", text: "User rejected. Code did not run." }], false,
		{ id: "confirmed-1", isError: true, durationMs: 0, metrics: { outcome: "confirmation_rejected", executed: false }, nestedCalls: { complete: true, calls: [] } });
	const messages = new GuiHistory(payloads).project(manager).entries.flatMap(entry => entry.messages);
	const history = transcriptReplies({ ...input(), messages, liveTools: [], streaming: false }).flatMap(row => row.kind === "reply" ? row.process : []).filter(item => item.kind === "tool");
	expect(history).toHaveLength(1);
	expect(history[0]?.tool).toMatchObject({ id: "confirmed-1", state: "stopped", args: { desc: "检查配置", confirm: "允许修改？" }, durationMs: 0 });
});
