import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { applyPersistedToolPruning, findCompletedToolCallIds, findPrunableToolCallIds, PRUNE_STATE, pruneToolTransactions } from "../../../src/harness/prune/prune.ts";
import { PruneService } from "../../../src/harness/prune/service.ts";
import { codeactResultToUser, codeactTranscript } from "../../../src/pimoon/codeact/transcript.ts";
import { isCodeActResultMessage, type CodeActMessage } from "../../../src/pimoon/codeact/types.ts";
import { assistant, solModel, user } from "./fixtures.ts";

function transaction(id: string, tool = "read", isError = false): [CodeActMessage, Extract<AgentMessage, { role: "custom" }>] {
	const code = `rows_${id} = read(path="${id}.txt")\n`;
	const message: CodeActMessage = { ...assistant([{ type: "text", text: "Keep the user's constraints." }, { type: "text", text: code }]), stopReason: "stop",
		codeact: { id, index: 1, complete: true }, codeactContent: [{ type: "text", text: `Keep the user's constraints.\n<execute>\n${code}</execute>` }] };
	return [message, { role: "custom", customType: "codeact_result", timestamp: 3, display: false,
		content: [{ type: "text", text: `${id} evidence\n`.repeat(500) }],
		details: { id, isError, durationMs: 10, metrics: { outcome: isError ? "python_error" : "success" },
			nestedCalls: { complete: true, calls: [{ id: `${id}/1`, name: tool, status: "ok" }] } } }];
}
const project = (messages: AgentMessage[]) => codeactTranscript(normalizeContext({ messages: convertToLlm(messages.map(codeactResultToUser)) }));

it("旧查询只裁剪输出，保留代码、约束、修改、错误与最近两次结果，不改原始历史", () => {
	const messages = [user("Do not change unrelated files."), ...transaction("old"), ...transaction("mutation", "edit"),
		...transaction("failure", "read", true), ...transaction("recent1"), ...transaction("recent2")];
	const original = structuredClone(messages);
	expect(findCompletedToolCallIds(messages)).toEqual(new Set(["old", "mutation", "failure", "recent1", "recent2"]));
	expect(findPrunableToolCallIds(messages)).toEqual(new Set(["old"]));
	const pruned = pruneToolTransactions(messages, findPrunableToolCallIds(messages));
	expect(pruned).toMatchObject({ removedToolCalls: 0, removedToolResults: 0, removedAssistantMessages: 0, prunedCodeActOutputs: 1 });
	const payload = JSON.stringify(project(pruned.messages));
	expect(payload).not.toContain("old evidence");
	for (const kept of ["rows_old", "Do not change unrelated", "mutation evidence", "failure evidence", "recent1 evidence", "recent2 evidence", "/prune restore"]) expect(payload).toContain(kept);
	expect(messages).toEqual(original);
	expect(project(pruned.messages).messages.some(message => message.role === "toolResult")).toBe(false);
});

it("force 与 restore 使用 SDK 持久化分支，恢复只改变上下文、不重放代码，后续输出仍保留", async () => {
	const manager = SessionManager.inMemory();
	for (const message of [user("inspect"), ...transaction("old"), ...transaction("recent1"), ...transaction("recent2")]) manager.appendMessage(message);
	const original = structuredClone(manager.buildSessionProjection().messages);
	const service = new PruneService();
	const port = { waitForIdle: async () => {}, getMessages: () => manager.buildSessionProjection().messages,
		getBranch: () => manager.getBranch(), appendState: (type: typeof PRUNE_STATE, state: unknown) => { manager.appendCustomEntry(type, state); } };
	const outcome = await service.execute({ operation: "force", model: undefined, port });
	expect(outcome).toMatchObject({ status: "applied", result: { prunedCodeActOutputs: 1 }, state: { toolCallIds: ["old"] } });
	const pruned = applyPersistedToolPruning(port.getMessages(), port.getBranch());
	expect(JSON.stringify(project(pruned))).not.toContain("old evidence");
	expect(await service.execute({ operation: "force", model: undefined, port })).toMatchObject({ code: "NO_CANDIDATES" });
	for (const message of transaction("later")) manager.appendMessage(message);
	expect(JSON.stringify(project(applyPersistedToolPruning(port.getMessages(), port.getBranch())))).toContain("later evidence");
	expect(await service.execute({ operation: "restore", model: undefined, port })).toMatchObject({ code: "RESTORED", restoredToolCalls: 1 });
	expect(applyPersistedToolPruning(port.getMessages(), port.getBranch()).slice(0, original.length)).toEqual(original);
});

it("成本预览使用真正的文本 CodeAct 投影和变化前缀，不将旧输出当作缓存命中", async () => {
	const manager = SessionManager.inMemory();
	for (const message of [user("inspect"), ...transaction("old"), ...transaction("recent1"), ...transaction("recent2")]) manager.appendMessage(message);
	const outcome = await new PruneService().execute({ operation: "prune", model: solModel(), port: {
		waitForIdle: async () => {}, getMessages: () => manager.buildSessionProjection().messages, getBranch: () => manager.getBranch(),
		appendState: (type, state) => { manager.appendCustomEntry(type, state); },
	} });
	expect(outcome).toMatchObject({ status: "applied", result: { prunedCodeActOutputs: 1 } });
	if (!("preview" in outcome)) throw new Error(JSON.stringify(outcome));
	expect(outcome.preview.prunedTokens).toBeLessThan(outcome.preview.fullTokens);
	expect(outcome.preview.commonPrefixTokens).toBeLessThan(outcome.preview.prunedTokens);
});

it("旧查询图片只从上下文移除，用户图片和最近结果保留", () => {
	const image = { type: "image" as const, data: "old-query-image", mimeType: "image/png" };
	const messages: AgentMessage[] = [{ ...user("compare"), content: [{ type: "image", data: "user-image", mimeType: "image/png" }] },
		...transaction("old"), ...transaction("recent1"), ...transaction("recent2")];
	const result = messages[2];
	if (!result || !isCodeActResultMessage(result)) throw new Error("fixture");
	result.content = [image];
	const original = structuredClone(messages);
	const pruned = pruneToolTransactions(messages, findPrunableToolCallIds(messages));
	const payload = JSON.stringify(project(pruned.messages));
	expect(payload).not.toContain("old-query-image");
	expect(payload).toContain("user-image");
	expect(messages).toEqual(original);
});

it("不裁剪孤立、重复 ID、未完成或缺少完整调用事实的结果", () => {
	const [execution, result] = transaction("duplicate");
	if (!execution || !result) throw new Error("fixture");
	expect(findCompletedToolCallIds([execution, execution, result])).toEqual(new Set());
	expect(findCompletedToolCallIds([result, execution])).toEqual(new Set());
	const messages = [...transaction("unknown"), ...transaction("recent1"), ...transaction("recent2")];
	const old = messages[1];
	if (!old || !isCodeActResultMessage(old)) throw new Error("fixture");
	old.details.nestedCalls = { complete: false, calls: [] };
	expect(findPrunableToolCallIds(messages)).toEqual(new Set());
});
