import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../../pimoon/runtime.mjs";
import { fingerprint, labels, record, pimoonTelemetry } from "../../pimoon/telemetry.ts";
import { agentHome } from "../../pimoon/profile.ts";
import path from "node:path";
import { checkWorkspacePath } from "../../pimoon/paths.ts";
import type { ExecutionTrace } from "../../pimoon/trace.ts";

interface RuntimeTags extends ExecutionTrace {
	runtime_id: string;
	workspace: ReturnType<typeof fingerprint>;
	prewarmed: boolean;
}

import { codemodeAllowedTools as allowed, codemodeHiddenDeclarations } from "../codemode/loadout.ts";
const description = "Use direct tools for single operations. Run persistent Python for batches, loops or computation. Tools accept keyword arguments. batch(name, jobs, limit=6) runs read/find/grep/ls concurrently (max 16); returns ordered {ok,value|error} items. Print needed results; no top-level return. observe(value, fields=[...], limit=8) projects tables. Output: 40k chars; _last_output retains up to 1 Mi chars. Python file I/O is workspace-only; no direct network, subprocess or FFI. Use bash, websearch or webfetch for process/network access through host tools. Errors raise or appear in structured results. Cancellation/restart clears variables, not completed writes. native_read(path): UTF-8 <=4 MiB.";

/** 用官方工具管线接真实 Python，不更改 SDK 解释器或绕过宿主审批。 */
export default function codemode(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;
	let runtimeSession: string | undefined;
	let runtimeTags: RuntimeTags | undefined;
	pimoonTelemetry(pi);
	const closeRuntime = (reason: string): void => {
		if (!runtime) return;
		record("runtime_closed", { ...runtimeTags, reason, had_state: runtime.hasState, python_pid: runtime.workerInfo?.pid, state_restored: false });
		runtime.close(); runtime = undefined; runtimeSession = undefined;
	};
	const runtimeFor = (ctx: ExtensionContext, tools: ConstructorParameters<typeof Runtime>[0]["tools"], prewarmed: boolean): Runtime => {
		const session = ctx.sessionManager.getSessionId();
		if (runtime && (runtime.dead || runtime.cwd !== ctx.cwd || runtimeSession !== session)) closeRuntime(runtime.dead ? "unavailable" : "session_changed");
		if (runtime) return runtime;
		const started = performance.now();
		const created = new Runtime({ transport: "rust", observe: false, cwd: ctx.cwd, tools: tools.filter(tool => allowed.has(tool.name) && tool.name !== "codemode") });
		runtime = created;
		runtimeSession = session;
		const tags = { ...labels(ctx), runtime_id: randomUUID(), workspace: fingerprint(ctx.cwd), prewarmed };
		runtimeTags = tags;
		record("runtime_created", tags);
		void created.ready.then(() => {
			if (runtime === created && !created.dead) record("runtime_ready", { ...tags, startup_ms: performance.now() - started, python_pid: created.workerInfo?.pid, python_version: created.workerInfo?.python_version });
		}, error => {
			if (runtime !== created) return;
			runtime = undefined;
			runtimeSession = undefined;
			created.close();
			record("runtime_start_failed", { ...tags, error: fingerprint(String(error)) });
		});
		return created;
	};
	// 初始工作区随应用启动初始化；只发送 INIT，不执行用户代码或调用工具。
	pi.on("session_start", (_event, ctx) => {
		if (!pi.getActiveTools().includes("codemode") || containsCredentials(ctx.cwd)) return;
		try { runtimeFor(ctx, pi.getAllTools(), true); }
		catch (error) { record("runtime_start_failed", { ...labels(ctx), error: fingerprint(String(error)) }); }
	});
	pi.on("session_shutdown", (event) => closeRuntime(event.reason));
	pi.on("before_agent_start", (_event, ctx) => {
		if (runtime?.hasState && runtimeSession === ctx.sessionManager.getSessionId()) return;
		if (!ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "codemode")) return;
		record("runtime_state_notice", { ...labels(ctx), reason: "history_without_memory", state_restored: false });
		return { message: { customType: "pimoon-runtime", content: "pimoon 的 Python 内存当前为空；历史聊天不等于变量恢复。必要时重新读取文件并重建变量，不要重放已完成写操作。请用中文回答。", display: true } };
	});
	pi.on("tool_call", async (event, ctx) => {
		const blocked = (reason: string): void => record("tool_blocked", { ...labels(ctx), tool_call_id: event.toolCallId,
			parent_tool_call_id: event.parentToolCallId, tool: event.toolName, reason });
		if (!allowed.has(event.toolName)) {
			blocked("tool_not_allowed");
			return { block: true, reason: "pimoon 未开放此工具。" };
		}
		if (containsCredentials(ctx.cwd)) {
			blocked("credential_workspace");
			return { block: true, reason: "不能把包含 pimoon 凭据的目录作为执行工作区。" };
		}
		if (event.toolName === "codemode" || event.toolName === "websearch" || event.toolName === "webfetch") return;
		const inputPath = event.toolName === "bash"
			? ("workdir" in event.input ? event.input.workdir : undefined)
			: ("path" in event.input ? event.input.path : undefined);
		const paths: unknown[] = Array.isArray(inputPath) ? inputPath : [inputPath ?? "."];
		try { for (const file of paths) { if (typeof file !== "string") throw new Error("无效路径。"); await checkWorkspacePath(ctx.cwd, file); } }
		catch (error) {
			blocked("workspace_path_rejected");
			return { block: true, reason: error instanceof Error ? error.message : "工作区路径校验失败。" };
		}
	});
	pi.on("user_bash", () => ({ result: { output: "请让 agent 使用 bash 工具执行命令，以沿用宿主审批。", exitCode: 1, cancelled: false, truncated: false } }));
	pi.registerTool({
		name: "codemode", label: "CodeAct", description, defaultActive: true, exposure: "model-only",
		promptSnippet: "Execute Python and compose tools; print decision-relevant observations.",
		parameters: Type.Object({ code: Type.String({ description: "Raw Python source, not JavaScript." }) }),
		reachesTools: () => "all",
		prepareLoadout(loadout) {
			return { hiddenDeclarations: codemodeHiddenDeclarations(loadout.declared) };
		},
		async execute(callId, args, signal, _update, ctx) {
			const start = performance.now(), trace = { ...labels(ctx), tool_call_id: callId };
			let active: Runtime | undefined, runtimeId: string | undefined, errorHash: ReturnType<typeof fingerprint> | undefined;
			record("code_start", { ...trace, code: fingerprint(args.code) });
			try {
				active = runtimeFor(ctx, ctx.tools, false); runtimeId = runtimeTags?.runtime_id;
				record("code_bound", { ...trace, runtime_id: runtimeId, python_pid: active.workerInfo?.pid, had_state: active.hasState });
				return await active.run(args.code, ctx, signal, 1, (type, fields) => record(type, {
					...trace, ...fields, code_call_id: callId, runtime_id: runtimeId,
				}));
			} catch (error) { errorHash = fingerprint(String(error)); throw error; }
			finally {
				const metrics = active?.lastMetrics ?? { outcome: signal?.aborted ? "cancelled" : "startup_error", metrics_complete: false };
				record("code_end", { ...trace, runtime_id: runtimeId, elapsed_ms: performance.now() - start,
					outcome: metrics.outcome, cancelled: signal?.aborted ?? false, error: errorHash, metrics });
			}
		},
	});
}

function containsCredentials(cwd: string): boolean {
	const relative = path.relative(cwd, agentHome);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
