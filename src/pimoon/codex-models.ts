import type { Model, Provider } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

/** 补齐 Pi 尚未发布的 Codex 目录；沿用原生传输、订阅认证和用户配置覆盖。 */
export function pimoonCodexProvider(): Provider<"openai-codex-responses"> {
	const provider = openaiCodexProvider();
	const models = [...provider.getModels()];
	// 参数来源：earendil-works/pi 的 catalog/providers/openai-codex.ts 与 families/openai.ts。
	for (const [id, name, contextWindow, input, output, cacheRead, cacheWrite] of [
		["gpt-6.2-astra", "GPT-6.2 Astra", 272000, 8, 40, 0.4, 10],
		["gpt-6.2-sol", "GPT-6.2 Sol", 500000, 2, 10, 0.1, 2.5],
	] as const) {
		const model: Model<"openai-codex-responses"> = {
			id, name, provider: provider.id, api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"],
			contextWindow, maxTokens: 128000,
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
			cost: { input, output, cacheRead, cacheWrite, tiers: [{ inputTokensAbove: 272000,
				input: input * 2, output: output * 1.5, cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 }] },
			compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true,
				supportsToolSearch: true, supportsMidConvoSystemMessages: true },
		};
		if (!models.some((entry) => entry.id === id)) models.push(model);
	}
	return { ...provider, getModels: () => models, getAllModels: () => models };
}
