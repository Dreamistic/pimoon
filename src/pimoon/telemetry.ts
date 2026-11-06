import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pimoonHome } from "./profile.ts";
import { TelemetryWriter } from "./telemetry-writer.ts";
import { applicationRunId, bindSessionTrace, clearSessionTrace, sessionTrace, type ExecutionTrace } from "./trace.ts";
import { getAssistantPerformance } from "../harness/message-performance/types.ts";
import packageInfo from "../../package.json" with { type: "json" };
import type { CodeActMessage } from "./codeact/transcript.ts";
import { APPROVAL_STATUS_CHANNEL, isApprovalStatusEvent } from "../harness/approval/events.ts";
import { CallTiming, processDuration } from "../harness/telemetry/call-timing.ts";
import { estimateRequestTokens, estimateResponseTokens, textTokens } from "./token-accounting.ts";
import { responseUsageStatus } from "./usage-status.ts";

const run = applicationRunId;
export const telemetryDirectory = path.join(pimoonHome, "telemetry", run);
const output = path.join(telemetryDirectory, `backend-${process.pid}.jsonl`);
let sequence = 0, enqueueMs = 0;
export let telemetryComplete = true;
function incomplete(): void {
	if (!telemetryComplete) return;
	telemetryComplete = false;
	console.error("pimoon：本地遥测写入失败或达到容量/队列上限，记录不完整。");
}
const writer = new TelemetryWriter(output, incomplete);
export const flushTelemetry = (): Promise<void> => writer.flush();
export const telemetryStats = () => ({ ...writer.stats, enqueueMs, complete: telemetryComplete });
let closing: Promise<void> | undefined;
export function closeTelemetry(): Promise<void> {
	closing ??= (async () => { record("backend_end", { telemetry_complete: telemetryComplete }); await writer.close(); })();
	return closing;
}
process.once("beforeExit", () => { void closeTelemetry(); });
export const fingerprint = (value: unknown) => {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	return { chars: text.length, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
};
export function record(type: string, fields: Record<string, unknown> = {}): void {
	if (!telemetryComplete) { writer.reject(); return; }
	const started = performance.now();
	try {
		const line = JSON.stringify({ schema: 2, app: "pimoon", run, pid: process.pid, seq: ++sequence, at: new Date().toISOString(), mono_ms: performance.now(), type, ...fields }) + "\n";
		writer.append(line);
	} catch { writer.reject(); writer.fail("serialization_error"); }
	finally { enqueueMs += performance.now() - started; }
}
interface Span { agent: string; request?: string; requestEnded: boolean; start: number; requestStart: number; calls: number; first: boolean; }
const spans = new Map<string, Span>();
export const requestBindings = new Map<string, { allowed: boolean; model: string | undefined; labels: ExecutionTrace }>();
export function labels(ctx: ExtensionContext): ExecutionTrace {
	return sessionTrace(ctx.sessionManager.getSessionId());
}
export function pimoonTelemetry(pi: ExtensionAPI): void {
	const tools = new Map<string, { timing: CallTiming; trace: ExecutionTrace }>();
	pi.events.on(APPROVAL_STATUS_CHANNEL, event => {
		if (!isApprovalStatusEvent(event)) return;
		const call = tools.get(event.toolCallId);
		if (!call) return;
		call.timing.approval(event);
		record(event.type === "requested" ? "approval_start" : "approval_end", {
			...call.trace, tool_call_id: event.toolCallId,
			...(event.type === "resolved" ? { outcome: event.outcome } : { tool: event.toolName }),
		});
	});
	pi.on("session_start", (event, ctx) => record("session_start", { ...labels(ctx), reason: event.reason, workspace: fingerprint(ctx.cwd) }));
	pi.on("before_agent_start", (event, ctx) => {
		const session = ctx.sessionManager.getSessionId(), agent = randomUUID();
		spans.set(session, { agent, start: performance.now(), requestStart: 0, requestEnded: true, calls: 0, first: false });
		bindSessionTrace(session, { agent_run_id: agent });
		record("agent_begin", { ...labels(ctx), input: fingerprint(event.messageType === "user" ? event.prompt : event.message) });
	});
	pi.on("before_provider_request", (event, ctx) => {
		const span = spans.get(ctx.sessionManager.getSessionId());
		if (span) {
			span.request = randomUUID(); span.requestStart = performance.now(); span.calls++; span.first = false; span.requestEnded = false;
			bindSessionTrace(ctx.sessionManager.getSessionId(), { agent_run_id: span.agent, model_request_id: span.request });
		}
		const payload = fingerprint(event.payload);
		requestBindings.set(payload.sha256, { labels: labels(ctx), model: ctx.model?.id, allowed: Boolean(span && ctx.model?.provider === "openai-codex") });
		if (requestBindings.size > 200) { const first = requestBindings.keys().next().value; if (first) requestBindings.delete(first); }
		record("model_request", { ...labels(ctx), provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel(),
			payload, token_estimate: estimateRequestTokens(event.payload) });
	});
	pi.on("after_provider_response", (event, ctx) => record("model_headers", { ...labels(ctx), status: event.status }));
	pi.on("provider_stream_event", (_event, ctx) => {
		const span = spans.get(ctx.sessionManager.getSessionId());
		if (span?.request && !span.requestEnded && !span.first) { span.first = true; record("model_first_event", { ...labels(ctx), elapsed_ms: performance.now() - span.requestStart }); }
	});
	// 源码流结束与执行开始分别计时，不制造第二套工具生命周期。
	pi.on("message_update", (event, ctx) => {
		const update = event.assistantMessageEvent;
		if (event.message.role !== "assistant") return;
		const message: CodeActMessage = event.message;
		if (update.type === "toolcall_end" && update.toolCall.name === "execute") {
			record("code_stream_end", { ...labels(ctx), tool_call_id: update.toolCall.id });
			return;
		}
		if (update.type !== "text_end" || !message.codeact?.complete || update.contentIndex !== message.codeact.index) return;
		record("code_stream_end", { ...labels(ctx), tool_call_id: message.codeact.id });
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message: CodeActMessage = event.message;
		const span = spans.get(ctx.sessionManager.getSessionId());
		const elapsed = span?.request && !span.requestEnded ? performance.now() - span.requestStart : null;
		if (elapsed !== null && span) span.requestEnded = true;
		// 工具取消可追加合成 assistant 错误，不把它算成同一模型请求的第二次结束。
		record(elapsed === null ? "assistant_end" : "model_end", { ...labels(ctx), provider: message.provider, model: message.model, elapsed_ms: elapsed,
			usage: message.usage, usage_reported: message.usage.totalTokens > 0, stop_reason: message.stopReason,
			usage_status: responseUsageStatus(message), token_estimate: elapsed === null ? undefined : estimateResponseTokens(message),
			stream_stop: message.codeactStop ? "stop_sequence" : undefined,
			performance: getAssistantPerformance(message), tool_calls: message.content.filter(part => part.type === "toolCall").map(part => ({ id: part.id, name: part.name })),
			error: message.errorMessage ? fingerprint(message.errorMessage) : undefined });
	});
	pi.on("tool_execution_start", (event, ctx) => {
		record("tool_start", { ...labels(ctx), tool_call_id: event.toolCallId, parent_tool_call_id: event.parentToolCallId, tool: event.toolName, input: fingerprint(event.args) });
		// 计时从遥测入队之后开始，结束时间在生成结果指纹之前采集。
		tools.set(event.toolCallId, { timing: new CallTiming(), trace: labels(ctx) });
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const ended = performance.now(), start = tools.get(event.toolCallId); tools.delete(event.toolCallId);
		const timing = start?.timing.finish(ended);
		const result: AgentToolResult<unknown> = event.result;
		const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		record("tool_end", { ...(start?.trace ?? labels(ctx)), tool_call_id: event.toolCallId, parent_tool_call_id: event.parentToolCallId,
			tool: event.toolName, is_error: event.isError, elapsed_ms: timing?.wall_ms ?? null, ...timing,
			execution_ms: event.durationMs, process_duration_ms: processDuration(event.toolName, result.details),
			output: fingerprint(event.result.content), output_text: fingerprint(text), returned_text_tokens: textTokens(text), token_method: "o200k_base" });
	});
	pi.on("agent_settled", (event, ctx) => {
		const span = spans.get(ctx.sessionManager.getSessionId());
		record("agent_settled", { ...labels(ctx), aborted: event.aborted, elapsed_ms: span ? performance.now() - span.start : null, requests: span?.calls, telemetry_enqueue_ms: enqueueMs, telemetry_pending_bytes: writer.stats.pendingBytes, telemetry_complete: telemetryComplete });
	});
	pi.on("session_shutdown", async (event, ctx) => {
		record("session_shutdown", { ...labels(ctx), reason: event.reason });
		spans.delete(ctx.sessionManager.getSessionId());
		tools.clear();
		clearSessionTrace(ctx.sessionManager.getSessionId());
		await flushTelemetry();
	});
}
record("backend_start", { author: "Dream", app_version: packageInfo.version, privacy: "local_metadata_only", jev: false, node: process.versions.node,
	platform: process.platform, arch: process.arch, output_limit_chars: 40_000, retention_limit_chars: 1024 * 1024,
	code_timeout_ms: 1_800_000, batch_max_jobs: 256, batch_max_concurrency: 6, orchestration_version: 1, scheduling: "explicit" });
