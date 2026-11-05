import { createAgentSessionFromServices, createAgentSessionServices, createAgentSessionRuntime, getAgentDir, parseArgs, resolveCliModel, runPrintMode, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSessionManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/main.js";
import { CodeAct } from "../../pimoon/codeact/session.ts";
import { createHarnessExtensions } from "../extensions.ts";

/** 桌面子代理使用同一个 CodeAct 系统，只暴露原生 execute 入口。 */
export async function runCodeActHeadless(args: string[]): Promise<number> {
	const parsed = parseArgs(args);
	const cwd = process.cwd(), agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const manager = await createSessionManager(parsed, cwd, parsed.sessionDir, settingsManager);
	const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const codeact = new CodeAct();
		const services = await createAgentSessionServices({ cwd, agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
			resourceLoaderOptions: {
				extensionFactories: createHarnessExtensions({ codeact, startup: parsed }),
				...(parsed.systemPrompt ? { systemPrompt: parsed.systemPrompt } : {}),
				noThemes: true, noPromptTemplates: true,
			},
		});
		const selection = resolveCliModel({ modelRuntime: services.modelRuntime,
			...(parsed.provider ? { cliProvider: parsed.provider } : {}), ...(parsed.model ? { cliModel: parsed.model } : {}),
			...(parsed.thinking ? { cliThinking: parsed.thinking } : {}),
		});
		if (selection.error) throw new Error(selection.error);
		if (parsed.apiKey && selection.model) await services.modelRuntime.setRuntimeApiKey(selection.model.provider, parsed.apiKey);
		const result = await createAgentSessionFromServices({ services, sessionManager,
			...(sessionStartEvent ? { sessionStartEvent } : {}), ...(selection.model ? { model: selection.model } : {}),
			...(parsed.thinking ?? selection.thinkingLevel ? { thinkingLevel: parsed.thinking ?? selection.thinkingLevel } : {}),
			...(parsed.tools ? { tools: ["execute", ...parsed.tools] } : {}),
		});
		codeact.bind(result.session);
		return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd, agentDir, sessionManager: manager });
	return runPrintMode(runtime, { mode: parsed.mode === "json" ? "json" : "text", messages: parsed.messages });
}
