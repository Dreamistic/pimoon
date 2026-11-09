import { beginApprovalBlock, endApprovalBlock } from "../../harness/approval/block.ts";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionToolContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../runtime.mjs";
import type { ExecutionScheduling } from "../scheduling.ts";
import { fingerprint, labels, record, pimoonTelemetry } from "../telemetry.ts";
import { agentHome, protectedCredentialPaths } from "../profile.ts";
import { checkReadablePath, checkWritablePath, protectedControlPaths } from "../paths.ts";
import { functionCatalog } from "./catalog.ts";
import { nativeInstructions, orchestrationInstructions } from "./native-instructions.ts";
import { isCodeActFunction } from "./functions.ts";
import type { ConfirmCodeAct } from "./confirmation.ts";
import type { CodeActMetadata } from "./metadata.ts";

const internal = (name: string) => name !== "execute" && isCodeActFunction(name);
const parameters = Type.Object({
    desc: Type.String({ minLength: 1, maxLength: 200, description: "Short purpose. Emit desc, confirm (if needed), then code." }),
    confirm: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Ask only when user intent is uncertain; not tool permission." })),
    code: Type.String({ minLength: 1, maxLength: 1024 * 1024, description: "Python source." }),
}, { additionalProperties: false });

/** 单一原生执行入口；内部 Python 函数沿用 SDK 权限与生命周期。 */
export class CodeAct {
    private session: AgentSession | undefined;
    private runtime: Runtime | undefined;
    private runtimeSession: string | undefined;
    private runtimeId: string | undefined;
    readonly extension: InlineExtension = { name: "codeact", builtin: true, factory: pi => this.register(pi) };

    constructor(private readonly confirm?: ConfirmCodeAct) {}

    bind(session: AgentSession): void {
        if (this.session) throw new Error("原生 CodeAct 已绑定。");
        this.session = session;
        for (const { definition } of session.extensionRunner.getAllRegisteredTools())
            if (definition.name !== "execute" && definition.exposure === "model-only") definition.exposure = "direct";
        session.setActiveToolsByName(["execute", ...session.getActiveToolNames().filter(internal)]);
        if (!session.getActiveToolNames().includes("execute")) throw new Error("会话工具允许列表必须包含 execute。");
        const before = session.agent.beforeToolCall;
        session.agent.beforeToolCall = async (event, signal) => {
            const calls = event.assistantMessage.content.filter(part => part.type === "toolCall");
            if (event.assistantMessage.stopReason !== "toolUse" || calls.length !== 1 || calls[0]?.name !== "execute")
                return { block: true, terminate: true, reason: "Expected exactly one execute call in a successful toolUse response. Nothing executed. Call execute directly; put parallel([...]) inside its Python code, not a native tool wrapper." };
            return before?.(event, signal);
        };
        const convert = session.agent.convertToLlm;
        session.agent.convertToLlm = async messages => {
            // 压缩投影可能隐藏旧执行；协议边界必须同时检查持久化分支。
            const legacyBranch = session.sessionManager.getBranch().some(entry =>
                entry.type === "custom_message" && entry.customType === "codeact_result"
                || entry.type === "message" && entry.message.role === "assistant" && "codeact" in entry.message);
            if (legacyBranch || messages.some(message => message.role === "custom" && message.customType === "codeact_result"
                || message.role === "assistant" && "codeact" in message))
                throw new Error("文本 CodeAct 历史仅可阅读；原生执行请新建会话。");
            return convert(messages);
        };
    }

    private register(pi: ExtensionAPI): void {
        pimoonTelemetry(pi);
        pi.registerTool({
            name: "execute", label: "Python", description: "Execute Python in the persistent CodeAct environment.",
            parameters, constrainedSampling: { type: "json_schema", strict: "prefer" },
            executionMode: "sequential",
            prepareLoadout: loadout => ({
                hiddenDeclarations: loadout.declared.filter(tool => tool.name !== "execute").map(tool => tool.name),
                descriptions: { execute: `Execute Python in the persistent CodeAct environment.\n${nativeInstructions}\n${orchestrationInstructions}\nFunctions:\n${functionCatalog(loadout.callable.filter(tool => internal(tool.name))) || "None."}` },
            }),
            execute: async (id, args, signal, update, ctx) => {
                if (!args.code.trim() || !args.desc.trim() || args.confirm !== undefined && !args.confirm.trim())
                    return { isError: true, content: [{ type: "text", text: "Empty code or metadata. Nothing executed." }], details: { executed: false } };
                const context = { ...ctx, signal };
                if (args.confirm) update?.({ content: [], details: { confirmationPending: true } });
                const blocked = await this.confirmExecution(args.code, id, args, context);
                if (args.confirm) update?.({ content: [], details: { confirmationPending: false } });
                if (blocked) return blocked;
                const started = performance.now();
                const result = await this.execute(args.code, id, context, scheduling => update?.({ content: [], details: { scheduling } }));
                return { ...result, details: { metrics: resultMetrics(result), scheduling: this.runtime?.lastScheduling, durationMs: performance.now() - started } };
            },
        });
        const restoreFunctions = (ctx: ExtensionContext) => {
            const entry = ctx.sessionManager.getBranch().findLast(item => item.type === "custom" && item.customType === "codeact_functions");
            const names: unknown = entry?.type === "custom" ? entry.data : undefined;
            if (Array.isArray(names) && names.every(name => typeof name === "string"))
                pi.setActiveTools(["execute", ...names.filter(internal)]);
        };
        pi.on("session_start", (_event, ctx) => {
            restoreFunctions(ctx);
            if (!this.session || containsCredentials(ctx.cwd)) return;
            try { this.runtimeFor(ctx, this.session.extensionRunner.createToolContext("codeact-prewarm", undefined), true); }
            catch (error) { record("runtime_start_failed", { ...labels(ctx), error: fingerprint(String(error)) }); }
        });
        pi.on("session_tree", (_event, ctx) => restoreFunctions(ctx));
        pi.on("before_agent_start", (_event, ctx) => {
            pi.setActiveTools(["execute", ...pi.getActiveTools().filter(internal)]);
            const names = pi.getActiveTools().filter(internal);
            const previous = ctx.sessionManager.getBranch().findLast(item => item.type === "custom" && item.customType === "codeact_functions");
            if (previous?.type !== "custom" || JSON.stringify(previous.data) !== JSON.stringify(names))
                pi.appendEntry("codeact_functions", names);
            if (this.runtime?.hasState && this.runtimeSession === ctx.sessionManager.getSessionId()) return;
            if (!ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "execute")) return;
            return { message: { customType: "pimoon-runtime", content: "Python 内存为空；历史不代表变量恢复。重新读取必要数据，不重放已完成写入。", display: true } };
        });
        pi.on("tool_call", async (event, ctx) => {
            if (containsCredentials(ctx.cwd)) return { block: true, reason: "不能把包含 pimoon 凭据的目录作为执行工作区。" };
            if (event.toolName === "execute") return event.parentToolCallId ? { block: true, reason: "禁止递归执行 execute。" } : undefined;
            if (!event.parentToolCallId || !internal(event.toolName)) return { block: true, reason: "仅允许 execute 内部函数调用。" };
            if (!this.session?.getCallableToolNames().includes(event.toolName)) return { block: true, reason: "此函数未启用。" };
            if (!["read", "find", "grep", "ls", "write", "edit", "process_run"].includes(event.toolName)) return;
            const value = event.toolName === "process_run" ? ("cwd" in event.input ? event.input.cwd : undefined) : ("path" in event.input ? event.input.path : undefined);
            const paths: unknown[] = Array.isArray(value) ? value : [value ?? "."];
            try {
                for (const file of paths) {
                    if (typeof file !== "string") throw new Error("无效路径。");
                    if (["write", "edit"].includes(event.toolName)) await checkWritablePath(ctx.cwd, file, protectedCredentialPaths);
                    else await checkReadablePath(ctx.cwd, file, protectedCredentialPaths, event.toolName !== "process_run");
                }
            } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
        });
        pi.on("user_bash", () => ({ result: { output: "请使用 execute 内的 subprocess.run，不执行 Shell 字符串。", exitCode: 1, cancelled: false, truncated: false } }));
        pi.on("session_shutdown", event => this.close(event.reason));
        pi.on("session_tree", () => this.close("session_tree"));
    }

	/** 整块确认只表达用户意图；执行时逐项检查函数能力与路径，风险审批由当前 CodeAct 统一绑定。 */
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

	private async execute(code: string, id: string, ctx: ExtensionContext, onScheduling: (value: ExecutionScheduling) => void): Promise<AgentToolResult<unknown>> {
		const started = performance.now(), trace = { ...labels(ctx), tool_call_id: id };
		const block = beginApprovalBlock(ctx.sessionManager.getSessionId(), id, ctx.cwd, code);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, block.controller.signal]) : block.controller.signal;
		record("code_start", { ...trace, code: fingerprint(code) });
		let errorHash: ReturnType<typeof fingerprint> | undefined;
		try {
			if (!this.session || containsCredentials(ctx.cwd)) throw new Error("无效 CodeAct 工作区。");
			const original = this.session.extensionRunner.createToolContext(id, signal);
			const executionContext: ExtensionToolContext = {
                ...original, ui: original.ui, mode: original.mode, hasUI: original.hasUI, cwd: original.cwd,
                sessionManager: original.sessionManager, signal: original.signal,
                tools: original.tools.filter(tool => internal(tool.name)), executeTool: original.executeTool.bind(original),
            };
			const runtime = this.runtimeFor(ctx, original);
			record("code_bound", { ...trace, runtime_id: this.runtimeId, python_pid: runtime.workerInfo?.pid, had_state: runtime.hasState });
			return await runtime.run(code, executionContext, signal, 1, (type, fields) => record(type, { ...trace, ...fields, code_call_id: id, runtime_id: this.runtimeId }), onScheduling);
		} catch (error) {
			errorHash = fingerprint(String(error));
			return { isError: true, content: [{ type: "text", text: block.stopReason ? `${block.stopReason}\nPython state may be lost; re-read required data. Completed side effects were not rolled back; do not replay them.` : (error instanceof Error ? error.message : String(error)) }], details: { metrics: this.runtime?.lastMetrics } };
		} finally {
			endApprovalBlock(block);
			record("code_end", { ...trace, runtime_id: this.runtimeId, elapsed_ms: performance.now() - started, outcome: this.runtime?.lastMetrics.outcome,
				cancelled: ctx.signal?.aborted ?? false, error: errorHash, metrics: this.runtime?.lastMetrics });
		}
	}

	private runtimeFor(ctx: ExtensionContext, context: ExtensionToolContext, prewarmed = false): Runtime {
		const session = ctx.sessionManager.getSessionId();
		if (this.runtime && (this.runtime.dead || this.runtime.cwd !== ctx.cwd || this.runtimeSession !== session)) this.close("session_changed");
		if (this.runtime) return this.runtime;
		const started = performance.now();
		const runtime = new Runtime({ transport: "rust", observe: false, cwd: ctx.cwd, timeoutMs: 1_800_000,
			protectedPaths: [...protectedCredentialPaths, ...protectedControlPaths()], tools: context.tools.filter(fn => internal(fn.name)) });
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
