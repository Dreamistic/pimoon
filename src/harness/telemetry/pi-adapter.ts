import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionTrace } from "../../pimoon/trace.ts";
import { codeFacts } from "../../pimoon/code-facts.ts";

import type {
	TelemetryPi,
	TelemetryService,
	TelemetrySessionContext,
} from "./service.ts";

/** 把 Pi 生命周期和上下文映射为 telemetry 的窄输入。 */
export function attachTelemetryService(pi: TelemetryPi, service: TelemetryService): void {
	pi.on("session_start", (event, ctx) => {
		const code = pi.getAllTools().find(tool => tool.name === "codemode");
		if (code) service.registerTool({ definition: { name: code.name, description: code.description, parameters: code.parameters,
			...(code.promptGuidelines === undefined ? {} : { promptGuidelines: code.promptGuidelines }) }, result: (_params, details) => codeFacts(details) });
		service.onSessionStart(event, sessionContext(ctx));
	});
	pi.on("turn_start", (event, ctx) => service.onTurnStart(event, {
		...(ctx.model === undefined ? {} : { model: { provider: ctx.model.provider, id: ctx.model.id } }),
	}));
	pi.on("message_end", (event) => service.onMessageEnd(event));
	pi.on("tool_execution_start", (event, ctx) => service.onToolExecutionStart(event, sessionTrace(ctx.sessionManager.getSessionId())));
	pi.on("tool_result", (event) => service.onToolResult(event));
	pi.on("tool_execution_end", (event) => service.onToolExecutionEnd(event));
	pi.on("session_shutdown", (event) => service.onSessionShutdown(event));
}

function sessionContext(ctx: ExtensionContext): TelemetrySessionContext {
	return {
		cwd: ctx.cwd,
		trace: sessionTrace(ctx.sessionManager.getSessionId()),
		sessionId: ctx.sessionManager.getSessionId(),
		notify(message) {
			try {
				ctx.ui.notify(message, "warning");
			} catch {
				// Writer failures may arrive after the Pi context becomes inactive.
			}
		},
	};
}
