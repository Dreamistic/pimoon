import type { Api, Model } from "@earendil-works/pi-ai";
import { fingerprint, record, requestBindings } from "./telemetry.ts";
import { sessionTrace } from "./trace.ts";

/** 辅助模型使用自己的显式模型绑定，不改主会话模型或消耗主请求的绑定。 */
export function bindAuxiliaryRequest(payload: unknown, model: Pick<Model<Api>, "id" | "provider">, session: string): void {
	const hash = fingerprint(payload);
	const labels = sessionTrace(session);
	requestBindings.set(hash.sha256, { allowed: Boolean(session) && model.provider === "openai-codex", model: model.id, labels });
	if (requestBindings.size > 200) {
		const first = requestBindings.keys().next().value;
		if (first) requestBindings.delete(first);
	}
	record("auxiliary_model_request", { ...labels, purpose: "approval", provider: model.provider, model: model.id, payload: hash });
}
