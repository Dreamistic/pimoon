import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pimoonHome } from "./profile.ts";
import { TelemetryWriter } from "./telemetry-writer.ts";
import { applicationRunId, bindSessionTrace, clearSessionTrace, sessionTrace, type ExecutionTrace } from "./trace.ts";
import { getAssistantPerformance } from "../harness/message-performance/types.ts";
import packageInfo from "../../package.json" with { type: "json" };

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
interface Span { agent: string; request?: string; start: number; requestStart: number; calls: number; first: boolean; }
const spans = new Map<string, Span>();
export const requestBindings = new Map<string, { allowed: boolean; model: string | undefined; labels: ExecutionTrace }>();
export function labels(ctx: ExtensionContext): ExecutionTrace {
	return sessionTrace(ctx.sessionManager.getSessionId());
}
export function pimoonTelemetry(pi: ExtensionAPI): void {
	const tools = new Map<string, { started: number; trace: ExecutionTrace }>();
	pi.on("session_start", (event, ctx) => record("session_start", { ...labels(ctx), reason: event.reason, workspace: fingerprint(ctx.cwd) }));
	pi.on("before_agent_start", (event, ctx) => {
		const session = ctx.sessionManager.getSessionId(), agent = randomUUID();
		spans.set(session, { agent, start: performance.now(), requestStart: 0, calls: 0, first: false });
		bindSessionTrace(session, { agent_run_id: agent });
		record("agent_begin", { ...labels(ctx), input: fingerprint(event.messageType === "user" ? event.prompt : event.message) });
	});
	pi.on("before_provider_request", (event, ctx) => {
		const span = spans.get(ctx.sessionManager.getSessionId());
		if (span) {
			span.request = randomUUID(); span.requestStart = performance.now(); span.calls++; span.first = false;
			bindSessionTrace(ctx.sessionManager.getSessionId(), { agent_run_id: span.agent, model_request_id: span.request });
		}
		const payload = fingerprint(event.payload);
		requestBindings.set(payload.sha256, { labels: labels(ctx), model: ctx.model?.id, allowed: Boolean(span && span.calls <= 20 && ctx.model?.provider === "openai-codex") });
		if (requestBindings.size > 200) { const first = requestBindings.keys().next().value; if (first) requestBindings.delete(first); }
		record("model_request", { ...labels(ctx), provider: ctx.model?.provider, model: ctx.model?.id, payload });
	});
	pi.on("after_provider_response", (event, ctx) => record("model_headers", { ...labels(ctx), status: event.status }));
	pi.on("provider_stream_event", (_event, ctx) => {
		const span = spans.get(ctx.sessionManager.getSessionId());
		if (span && !span.first) { span.first = true; record("model_first_event", { ...labels(ctx), elapsed_ms: performance.now() - span.requestStart }); }
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;
		const span = spans.get(ctx.sessionManager.getSessionId());
		record("model_end", { ...labels(ctx), provider: message.provider, model: message.model, elapsed_ms: span?.request ? performance.now() - span.requestStart : null,
			usage: message.usage, usage_reported: message.usage.totalTokens > 0, stop_reason: message.stopReason,
			performance: getAssistantPerformance(message), tool_calls: message.content.filter(part => part.type === "toolCall").map(part => ({ id: part.id, name: part.name })),
			error: message.errorMessage ? fingerprint(message.errorMessage) : undefined });
	});
	pi.on("tool_execution_start", (event, ctx) => {
		record("tool_start", { ...labels(ctx), tool_call_id: event.toolCallId, parent_tool_call_id: event.parentToolCallId, tool: event.toolName, input: fingerprint(event.args) });
		// 计时从遥测入队之后开始，结束时间在生成结果指纹之前采集。
		tools.set(event.toolCallId, { started: performance.now(), trace: labels(ctx) });
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const ended = performance.now(), start = tools.get(event.toolCallId); tools.delete(event.toolCallId);
		const result: AgentToolResult<unknown> = event.result;
		const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		record("tool_end", { ...(start?.trace ?? labels(ctx)), tool_call_id: event.toolCallId, parent_tool_call_id: event.parentToolCallId,
			tool: event.toolName, is_error: event.isError, elapsed_ms: start === undefined ? null : ended - start.started,
			output: fingerprint(event.result.content), output_text: fingerprint(text) });
	});
	pi.on("agent_settled", (event, ctx) => {
		const span = spans.get(ctx.sessionManager.getSessionId());
		record("agent_settled", { ...labels(ctx), aborted: event.aborted, elapsed_ms: span ? performance.now() - span.start : null, requests: span?.calls, telemetry_enqueue_ms: enqueueMs, telemetry_pending_bytes: writer.stats.pendingBytes, telemetry_complete: telemetryComplete });
	});
	pi.on("session_shutdown", async (event, ctx) => {
		record("session_shutdown", { ...labels(ctx), reason: event.reason });
		spans.delete(ctx.sessionManager.getSessionId());
		clearSessionTrace(ctx.sessionManager.getSessionId());
		await flushTelemetry();
	});
}
record("backend_start", { author: "Dream", app_version: packageInfo.version, privacy: "local_metadata_only", jev: false, node: process.versions.node,
	platform: process.platform, arch: process.arch, output_limit_chars: 40_000, retention_limit_chars: 1024 * 1024,
	request_budget: 20, code_timeout_ms: 45_000, batch_max_jobs: 256, batch_max_concurrency: 16 });
