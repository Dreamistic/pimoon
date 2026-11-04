import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext, ExtensionToolContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { NestedToolCallRecord } from "@earendil-works/pi-ai";
import { Runtime } from "../runtime.mjs";
import { fingerprint, labels, record, pimoonTelemetry } from "../telemetry.ts";
import { agentHome, protectedCredentialPaths } from "../profile.ts";
import { checkReadablePath, checkWorkspacePath } from "../paths.ts";
import { functionCatalog } from "./catalog.ts";
import { codeactInstructions } from "./prompt.ts";
import { codeactStream } from "./stream.ts";
import { CODEACT_RESULT, codeactSource, isCodeActResult, type CodeActMessage, type CodeActResult } from "./types.ts";

type ExecutionEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>;
import { CODEACT_EXECUTION, type CodeActExecutionEvent } from "./events.ts";
import { isCodeActFunction } from "./functions.ts";
import type { ConfirmCodeAct } from "./confirmation.ts";
import type { CodeActMetadata } from "./metadata.ts";

/** 执行块直接在轮次边界运行；内部 I/O 沿用校验与审批，不注册执行工具。 */
export class CodeAct {
	private session: AgentSession | undefined;
	private runtime: Runtime | undefined;
	private runtimeSession: string | undefined;
	private runtimeId: string | undefined;
	private publish: (event: ExecutionEvent) => void = () => {};
	private calls: NestedToolCallRecord[] | undefined;
	private callsComplete = true;
	private callStarted = new Map<string, number>();

	readonly extension: InlineExtension = { name: "codeact", builtin: true, factory: pi => this.register(pi) };

	constructor(private readonly confirm?: ConfirmCodeAct) {}

	bind(session: AgentSession, publish?: (event: ExecutionEvent) => void): void {
		if (this.session) throw new Error("CodeAct 已绑定会话。");
		this.session = session;
		// SDK 的 model-only 能力在本系统中也是内部函数，不再保留模型直调通道。
		for (const { definition } of session.extensionRunner.getAllRegisteredTools()) if (definition.exposure === "model-only") definition.exposure = "direct";
		session.setActiveToolsByName(session.getActiveToolNames().filter(isCodeActFunction));
		this.publish = publish ?? (() => {});
		session.agent.streamFunction = codeactStream(session.agent.streamFunction, () => {
			const context = session.extensionRunner.createToolContext("codeact-catalog", session.agent.signal);
			return `${codeactInstructions}\nFunctions:\n${functionCatalog(context.tools.filter(fn => isCodeActFunction(fn.name))) || "None."}`;
		});
		const convert = session.agent.convertToLlm;
		session.agent.convertToLlm = messages => convert(messages.map(message => {
			if (message.role !== "custom" || message.customType !== CODEACT_RESULT || !isCodeActResult(message.details)) return message;
			const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
			return { role: "user" as const, timestamp: message.timestamp, content: [
				{ type: "text" as const, text: `<execute_result status="${message.details.isError ? "error" : "ok"}">\n${text}\n</execute_result>` },
				...content.filter(part => part.type === "image"),
			] };
		}));
	}

	private register(pi: ExtensionAPI): void {
		pimoonTelemetry(pi);
		const restoreFunctions = (ctx: ExtensionContext) => {
			const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "codeact_functions");
			const data: unknown = entry?.type === "custom" ? entry.data : undefined;
			const names = Array.isArray(data) && data.every((name): name is string => typeof name === "string") ? data : pi.getActiveTools();
			pi.setActiveTools(names.filter(isCodeActFunction));
		};
		pi.on("session_tree", (_event, ctx) => restoreFunctions(ctx));
		pi.on("session_start", (_event, ctx) => {
			restoreFunctions(ctx);
			if (!this.session || containsCredentials(ctx.cwd)) return;
			try { this.runtimeFor(ctx, this.session.extensionRunner.createToolContext("codeact-prewarm", undefined), true); }
			catch (error) { record("runtime_start_failed", { ...labels(ctx), error: fingerprint(String(error)) }); }
		});
		pi.on("session_shutdown", event => this.close(event.reason));
		pi.on("before_agent_start", (_event, ctx) => {
			pi.setActiveTools(pi.getActiveTools().filter(isCodeActFunction));
			const names = pi.getActiveTools();
			const previous = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "codeact_functions");
			if (previous?.type !== "custom" || JSON.stringify(previous.data) !== JSON.stringify(names)) pi.appendEntry("codeact_functions", names);
			if (this.runtime?.hasState && this.runtimeSession === ctx.sessionManager.getSessionId()) return;
			if (!ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === CODEACT_RESULT)) return;
			return { message: { customType: "pimoon-runtime", content: "Python 内存为空；历史不代表变量恢复。重新读取必要数据，不重放已完成写入。", display: true } };
		});
		pi.on("tool_call", async (event, ctx) => {
			if (!event.parentToolCallId || !isCodeActFunction(event.toolName)) return { block: true, reason: "仅允许 CodeAct 内部函数调用。" };
			if (containsCredentials(ctx.cwd)) return { block: true, reason: "不能把包含 pimoon 凭据的目录作为执行工作区。" };
			if (!this.session?.getCallableToolNames().includes(event.toolName)) return { block: true, reason: "此函数未启用。" };
			if (!["read", "find", "grep", "ls", "write", "edit", "process_run"].includes(event.toolName)) return;
			const input = event.input;
			const value = event.toolName === "process_run" ? ("cwd" in input ? input.cwd : undefined) : ("path" in input ? input.path : undefined);
			const paths: unknown[] = Array.isArray(value) ? value : [value ?? "."];
			try {
				for (const file of paths) {
					if (typeof file !== "string") throw new Error("无效路径。");
					if (["write", "edit"].includes(event.toolName)) await checkWorkspacePath(ctx.cwd, file);
					else await checkReadablePath(ctx.cwd, file, protectedCredentialPaths);
				}
			} catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
		});
		pi.on("user_bash", () => ({ result: { output: "请使用 CodeAct 的 process_run(argv=[...])，不执行 Shell 字符串。", exitCode: 1, cancelled: false, truncated: false } }));
		pi.on("tool_execution_start", event => {
			if (!this.calls || !event.parentToolCallId) return;
			if (this.calls.length >= 256) { this.callsComplete = false; return; }
			const size = Buffer.byteLength(JSON.stringify(event.args));
			this.callStarted.set(event.toolCallId, performance.now());
			this.calls.push({ id: event.toolCallId, name: event.toolName, status: "unfinished", ...(size <= 16_384 ? { arguments: structuredClone(event.args) } : { argumentsBytes: size }) });
		});
		pi.on("tool_execution_end", event => {
			const call = this.calls?.find(item => item.id === event.toolCallId);
			const started = this.callStarted.get(event.toolCallId); this.callStarted.delete(event.toolCallId);
			if (event.durationMs === undefined && started !== undefined) event.durationMs = performance.now() - started;
			if (call) {
				call.status = event.isError ? "error" : "ok";
				if (event.durationMs !== undefined) call.durationMs = event.durationMs;
				if (event.isError) {
					const result: AgentToolResult<unknown> = event.result;
					call.error = result.content.filter(part => part.type === "text").map(part => part.text).join("\n").slice(0, 600);
				}
			}
		});
		pi.on("turn_end", async (event, ctx) => {
			if (event.message.role !== "assistant" || event.message.stopReason !== "stop" || ctx.signal?.aborted) return;
			const message: CodeActMessage = event.message;
			if (!message.codeact?.complete) return;
			const source = codeactSource(message);
			if (source === undefined || !this.session) return;
			const { id, desc, confirm } = message.codeact;
			const args = { code: source, desc, confirm };
			this.calls = []; this.callsComplete = true; this.callStarted.clear();
			this.publish({ type: "tool_execution_start", toolCallId: id, toolName: "codeact", args: { ...args, confirmationPending: Boolean(confirm) } });
			const blocked = await this.confirmExecution(source, id, { desc, confirm }, ctx);
			let result: AgentToolResult<unknown>, durationMs = 0;
			if (blocked) result = blocked;
			else {
				if (confirm) this.publish({ type: "tool_execution_update", toolCallId: id, toolName: "codeact", args,
					partialResult: { content: [] } });
				const started = performance.now();
				pi.events.emit(CODEACT_EXECUTION, { phase: "start", id, trace: labels(ctx) } satisfies CodeActExecutionEvent);
				result = await this.execute(source, id, ctx);
				durationMs = performance.now() - started;
			}
			const metrics = resultMetrics(result);
			const details: CodeActResult = { id, isError: result.isError === true, durationMs, metrics,
				nestedCalls: { complete: this.callsComplete, calls: this.calls },
			};
			this.calls = undefined; this.callStarted.clear();
			const output = { ...result, details: { metrics } };
			if (!blocked) pi.events.emit(CODEACT_EXECUTION, { phase: "end", id, result: output, isError: details.isError, durationMs } satisfies CodeActExecutionEvent);
			this.publish({ type: "tool_execution_end", toolCallId: id, toolName: "codeact", result: output, isError: details.isError, durationMs });
			return { entries: [{ type: "custom_message", customType: CODEACT_RESULT, content: result.content, display: false, details }], continue: !ctx.signal?.aborted };
		});
	}

	/** 整块确认只表达用户意图；真正执行时仍逐项检查函数权限与审批。 */
	private async confirmExecution(code: string, id: string, metadata: CodeActMetadata, ctx: ExtensionContext): Promise<AgentToolResult<unknown> | undefined> {
		const skipped = (outcome: string, text: string): AgentToolResult<unknown> => ({ isError: true,
			content: [{ type: "text", text }], details: { metrics: { outcome, executed: false, metrics_complete: true } } });
		if (ctx.signal?.aborted) return skipped("cancelled", "Cancelled before execution. Code did not run.");
		if (!metadata.confirm) return;
		if (!this.confirm) return skipped("confirmation_unavailable", "Confirmation requires an interactive UI. Code did not run; do not retry without user approval.");
		// 自动命名、书签和用量记录不改变执行上下文，不能让后台更新使用户确认失效。
		const branch = () => ctx.sessionManager.getBranch().findLast(entry => !["session_info", "label", "usage"].includes(entry.type))?.id;
		const session = ctx.sessionManager.getSessionId(), leaf = branch(), runtime = this.runtime, cwd = ctx.cwd;
		try {
			const decision = await this.confirm({ id, cwd, code, desc: metadata.desc, reason: metadata.confirm }, ctx.signal);
			if (ctx.signal?.aborted || decision.kind === "cancelled") return skipped("cancelled", "Confirmation cancelled. Code did not run.");
			if (decision.kind === "rejected") return skipped("confirmation_rejected", `User rejected this execution. Code did not run. Do not retry without approval.${decision.feedback?.trim() ? `\nUser feedback:\n${decision.feedback.trim()}` : ""}`);
			if (ctx.sessionManager.getSessionId() !== session || branch() !== leaf || path.resolve(ctx.sessionManager.getCwd()) !== path.resolve(cwd) || this.runtime !== runtime || runtime?.dead)
				return skipped("confirmation_invalidated", "Execution context changed while awaiting confirmation. Code did not run; request a new confirmation.");
		} catch {
			return skipped("confirmation_unavailable", "Confirmation failed. Code did not run; do not retry without user approval.");
		}
		return;
	}

	private async execute(code: string, id: string, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
		const started = performance.now(), trace = { ...labels(ctx), tool_call_id: id };
		record("code_start", { ...trace, code: fingerprint(code) });
		let errorHash: ReturnType<typeof fingerprint> | undefined;
		try {
			if (!this.session || containsCredentials(ctx.cwd)) throw new Error("无效 CodeAct 工作区。");
			const context = this.session.extensionRunner.createToolContext(id, ctx.signal);
			const runtime = this.runtimeFor(ctx, context, false);
			record("code_bound", { ...trace, runtime_id: this.runtimeId, python_pid: runtime.workerInfo?.pid, had_state: runtime.hasState });
			return await runtime.run(code, context, ctx.signal, 1, (type, fields) => record(type, { ...trace, ...fields, code_call_id: id, runtime_id: this.runtimeId }));
		} catch (error) {
			errorHash = fingerprint(String(error));
			return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: { metrics: this.runtime?.lastMetrics } };
		} finally {
			record("code_end", { ...trace, runtime_id: this.runtimeId, elapsed_ms: performance.now() - started, outcome: this.runtime?.lastMetrics.outcome,
				cancelled: ctx.signal?.aborted ?? false, error: errorHash, metrics: this.runtime?.lastMetrics });
		}
	}

	private runtimeFor(ctx: ExtensionContext, context: ExtensionToolContext, prewarmed: boolean): Runtime {
		const session = ctx.sessionManager.getSessionId();
		if (this.runtime && (this.runtime.dead || this.runtime.cwd !== ctx.cwd || this.runtimeSession !== session)) this.close("session_changed");
		if (this.runtime) return this.runtime;
		const started = performance.now();
		const runtime = new Runtime({ transport: "rust", observe: false, cwd: ctx.cwd, timeoutMs: 1_800_000,
			protectedPaths: protectedCredentialPaths, tools: context.tools.filter(fn => isCodeActFunction(fn.name)) });
		this.runtime = runtime; this.runtimeSession = session; this.runtimeId = randomUUID();
		const tags = { ...labels(ctx), runtime_id: this.runtimeId, workspace: fingerprint(ctx.cwd), prewarmed };
		record("runtime_created", tags);
		void runtime.ready.then(() => record("runtime_ready", { ...tags, startup_ms: performance.now() - started, python_pid: runtime.workerInfo?.pid }),
			error => { record("runtime_start_failed", { ...tags, error: fingerprint(String(error)) }); runtime.close(); });
		return runtime;
	}

	private close(reason: string): void {
		if (!this.runtime) return;
		record("runtime_closed", { runtime_id: this.runtimeId, reason, had_state: this.runtime.hasState, python_pid: this.runtime.workerInfo?.pid, state_restored: false });
		this.runtime.close(); this.runtime = undefined; this.runtimeSession = undefined;
	}
}

function resultMetrics(result: AgentToolResult<unknown>): Record<string, unknown> {
	const details = result.details;
	if (typeof details === "object" && details !== null && "metrics" in details && typeof details.metrics === "object" && details.metrics !== null)
		return { ...details.metrics };
	return { outcome: "startup_error", metrics_complete: false };
}

function containsCredentials(cwd: string): boolean {
	const relative = path.relative(cwd, agentHome);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
