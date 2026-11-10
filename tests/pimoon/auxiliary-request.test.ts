import { expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
const telemetry = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../../src/pimoon/telemetry.ts", () => ({ ...telemetry, fingerprint: () => ({ sha256: "fixture", chars: 10, bytes: 10 }) }));
import { bindAuxiliaryRequest } from "../../src/pimoon/auxiliary-request.ts";
import { bindSessionTrace, sessionTrace } from "../../src/pimoon/trace.ts";

it("辅助请求使用独立关联、成功或失败都结算一次，主请求绑定不变", () => {
	bindSessionTrace("fixture", { agent_run_id: "agent", model_request_id: "main" });
	const first = bindAuxiliaryRequest({ instructions: "PRIVATE_PROMPT", input: [{ role: "user", content: "PRIVATE_INPUT" }] }, { id: "sol", provider: "openai-codex" }, "fixture");
	const response: AssistantMessage = { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "sol", timestamp: 1,
		content: [{ type: "text", text: "PRIVATE_RESPONSE" }], stopReason: "stop",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	first.finish(response); first.finish();
	const second = bindAuxiliaryRequest({ input: [] }, { id: "sol", provider: "openai-codex" }, "fixture");
	second.finish(); second.finish(response);
	const calls = telemetry.record.mock.calls;
	expect(calls.map(call => call[0])).toEqual(["auxiliary_model_request", "auxiliary_model_end", "auxiliary_model_request", "auxiliary_model_end"]);
	const request = calls[0]?.[1];
	expect(request).toMatchObject({ parent_model_request_id: "main", purpose: "approval" });
	expect(request.model_request_id).not.toBe("main");
	expect(calls[1]?.[1]).toMatchObject({ model_request_id: request.model_request_id, usage_status: "complete", usage: { totalTokens: 15 } });
	expect(calls[3]?.[1]).toMatchObject({ usage_status: "unavailable", stop_reason: "error" });
	expect(sessionTrace("fixture").model_request_id).toBe("main");
	expect(JSON.stringify(calls)).not.toContain("PRIVATE_");
});
