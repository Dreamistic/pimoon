import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { fingerprint, record, requestBindings } from "./telemetry.ts";
import { sessionTrace } from "./trace.ts";
import { estimateRequestTokens, estimateResponseTokens } from "./token-accounting.ts";
import { responseUsageStatus } from "./usage-status.ts";

/** 辅助请求有独立 ID 和终态，不覆盖主模型关联，也不记录提示词或响应正文。 */
export function bindAuxiliaryRequest(payload: unknown, model: Pick<Model<Api>, "id" | "provider">, session: string) {
	const hash = fingerprint(payload), parent = sessionTrace(session);
	const labels = { ...parent, parent_model_request_id: parent.model_request_id, model_request_id: randomUUID() };
	requestBindings.set(hash.sha256, { allowed: Boolean(session) && model.provider === "openai-codex", model: model.id, labels });
	if (requestBindings.size > 200) {
		const first = requestBindings.keys().next().value;
		if (first) requestBindings.delete(first);
	}
	const started = performance.now();
	record("auxiliary_model_request", { ...labels, purpose: "approval", provider: model.provider, model: model.id,
		payload: hash, token_estimate: estimateRequestTokens(payload) });
	let ended = false;
	return {
		id: labels.model_request_id,
		finish(response?: AssistantMessage): void {
			if (ended) return;
			ended = true;
			record("auxiliary_model_end", { ...labels, purpose: "approval", provider: model.provider, model: model.id,
				elapsed_ms: performance.now() - started, stop_reason: response?.stopReason ?? "error",
				usage: response?.usage, usage_reported: (response?.usage.totalTokens ?? 0) > 0,
				usage_status: response ? responseUsageStatus(response) : "unavailable",
				token_estimate: response ? estimateResponseTokens(response) : undefined });
		},
	};
}
