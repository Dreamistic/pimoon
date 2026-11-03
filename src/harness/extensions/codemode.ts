import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../../pimoon/runtime.mjs";
import { fingerprint, labels, record, pimoonTelemetry } from "../../pimoon/telemetry.ts";
import { agentHome, protectedCredentialPaths } from "../../pimoon/profile.ts";
import path from "node:path";
import { checkReadablePath, checkWorkspacePath } from "../../pimoon/paths.ts";
import type { ExecutionTrace } from "../../pimoon/trace.ts";

interface RuntimeTags extends ExecutionTrace {
	runtime_id: string;
	workspace: ReturnType<typeof fingerprint>;
	prewarmed: boolean;
}

import { codemodeAllowedTools as allowed, codemodeHiddenDeclarations, codemodeSelection } from "../codemode/loadout.ts";
import { codemodeCatalog } from "../codemode/catalog.ts";
const description = "CodeAct: the only execution entry. Use persistent Python variables, conditions and functions to process data and orchestrate host functions. Call enabled host functions with keyword arguments; ? marks optional arguments (omit, do not pass None). The final top-level expression is displayed automatically (except None); _ retains its full value. Assign intermediate results, process them in Python, then end with only the evidence needed for the next decision. Example: rows=find(query='README')['matches']; rows[:3]. print is optional for progress; no top-level return. Images are forwarded unchanged. batch(name, jobs, limit=6) runs independent read/find/grep/ls jobs concurrently (max 16), returning ordered {ok,value|error} items. observe(value, fields=[...], limit=8) projects tables. Output: 40k chars; _last_output retains up to 1 Mi chars. Analyze files in Python, not bash-launched Python. Reads may leave the workspace; writes stay inside. Protected credential paths are blocked. No direct network, subprocess or FFI. Use enabled bash/websearch/webfetch functions for process/network access; host approvals still apply. Errors raise or appear in structured results. Cancellation/restart clears variables, not completed writes. native_read(path): UTF-8 <=4 MiB.";

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
		const created = new Runtime({ transport: "rust", observe: false, cwd: ctx.cwd, protectedPaths: protectedCredentialPaths, tools: tools.filter(tool => allowed.has(tool.name) && tool.name !== "codemode") });
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
	const activateEntry = (): void => {
		const active = pi.getActiveTools(), selected = codemodeSelection(active.filter(name => allowed.has(name)));
		if (selected.length !== active.length || selected.some((name, index) => name !== active[index])) pi.setActiveTools(selected);
	};
	// 初始工作区随应用启动初始化；只发送 INIT，不执行用户代码或调用工具。
	pi.on("session_start", (_event, ctx) => {
		activateEntry();
		if (!pi.getActiveTools().includes("codemode") || containsCredentials(ctx.cwd)) return;
		try { runtimeFor(ctx, pi.getAllTools(), true); }
		catch (error) { record("runtime_start_failed", { ...labels(ctx), error: fingerprint(String(error)) }); }
	});
	pi.on("session_shutdown", (event) => closeRuntime(event.reason));
	pi.on("before_agent_start", (_event, ctx) => {
		activateEntry();
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
		if (event.toolName !== "codemode" && !event.parentToolCallId) {
			blocked("codeact_required");
			return { block: true, reason: "请通过 codemode 执行 Python 并调用宿主工具。" };
		}
		if (event.toolName !== "codemode" && !pi.getActiveTools().includes(event.toolName)) {
			blocked("tool_disabled");
			return { block: true, reason: "此宿主工具未启用。" };
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
		try {
			for (const file of paths) {
				if (typeof file !== "string") throw new Error("无效路径。");
				if (["read", "find", "grep", "ls"].includes(event.toolName)) await checkReadablePath(ctx.cwd, file, protectedCredentialPaths);
				else await checkWorkspacePath(ctx.cwd, file);
			}
		}
		catch (error) {
			blocked("filesystem_path_rejected");
			return { block: true, reason: error instanceof Error ? error.message : "文件路径校验失败。" };
		}
	});
	pi.on("user_bash", () => ({ result: { output: "请让 agent 通过 CodeAct 调用 bash，以沿用宿主审批。", exitCode: 1, cancelled: false, truncated: false } }));
	pi.registerTool({
		name: "codemode", label: "CodeAct", description, defaultActive: true, exposure: "model-only",
		promptSnippet: "CodeAct: execute Python and orchestrate enabled host functions.",
		executionMode: "sequential",
		parameters: Type.Object({ code: Type.String({ description: "Raw Python source, not JavaScript." }) }),
		reachesTools: () => pi.getActiveTools().filter(name => name !== "codemode" && allowed.has(name)),
		prepareLoadout(loadout) {
			const catalog = codemodeCatalog(loadout.declared);
			return {
				hiddenDeclarations: codemodeHiddenDeclarations(loadout.declared),
				descriptions: { codemode: `${description}\nEnabled host functions:\n${catalog || "None."}` },
			};
		},
		async execute(callId, args, signal, _update, ctx) {
			const start = performance.now(), trace = { ...labels(ctx), tool_call_id: callId };
			let active: Runtime | undefined, runtimeId: string | undefined, errorHash: ReturnType<typeof fingerprint> | undefined;
			record("code_start", { ...trace, code: fingerprint(args.code) });
			try {
				active = runtimeFor(ctx, pi.getAllTools(), false); runtimeId = runtimeTags?.runtime_id;
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
