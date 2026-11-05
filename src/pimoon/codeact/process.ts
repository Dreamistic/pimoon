import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import which from "which";
import { DEFAULT_PROCESS_TIMEOUT_SECONDS } from "./process-budget.ts";

export interface ProcessInput {
	argv: string[];
	cwd?: string;
	env?: Record<string, string>;
	inherit_env?: boolean;
	timeout?: number;
	check?: boolean;
}
export interface ProcessResult {
	exit_code: number | null;
	status: "exited" | "cancelled" | "timeout" | "spawn_error";
	stdout: string;
	stderr: string;
	truncated: boolean;
	duration_ms: number;
}
export function isProcessResult(value: unknown): value is ProcessResult {
 return typeof value === "object" && value !== null
  && "status" in value && ["exited", "cancelled", "timeout", "spawn_error"].some(status => status === value.status)
  && "exit_code" in value && (value.exit_code === null || typeof value.exit_code === "number" && Number.isInteger(value.exit_code))
  && "stdout" in value && typeof value.stdout === "string" && "stderr" in value && typeof value.stderr === "string"
  && "truncated" in value && typeof value.truncated === "boolean"
  && "duration_ms" in value && typeof value.duration_ms === "number" && Number.isFinite(value.duration_ms);
}
const OUTPUT_BYTES = 65_536;

/** 参数数组直接启动程序，不经过 Shell；Windows 包装入口只转换已知 npm/Gradle。 */
export async function runProcess(input: ProcessInput, workspace: string, signal?: AbortSignal): Promise<ProcessResult> {
	const started = performance.now();
	const cwd = path.resolve(workspace, input.cwd ?? ".");
	const env: NodeJS.ProcessEnv = input.inherit_env === false ? {} : { ...process.env };
	for (const [name, value] of Object.entries(input.env ?? {})) {
		if (!name || name.includes("=") || name.includes("\0") || value.includes("\0")) throw new Error("无效环境变量。");
		if (process.platform === "win32") for (const existing of Object.keys(env)) if (existing.toLowerCase() === name.toLowerCase()) delete env[existing];
		env[name] = value;
	}
	if (signal?.aborted) return { exit_code: null, status: "cancelled", stdout: "", stderr: "Cancelled", truncated: false, duration_ms: 0 };
	const [executable, ...args] = await resolveProgram(input.argv, cwd, env);
	if (!executable) throw new Error("argv 不能为空。");
	return new Promise(resolve => {
		const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const output: Buffer[] = [], errors: Buffer[] = [];
		let outputBytes = 0, errorBytes = 0, truncated = false, status: ProcessResult["status"] = "exited";
		let spawnError: string | undefined, stopping: Promise<void> | undefined;
		const capture = (chunks: Buffer[], data: Buffer, used: number): number => {
			const remaining = Math.max(0, OUTPUT_BYTES - used);
			if (data.length > remaining) truncated = true;
			if (remaining) chunks.push(data.subarray(0, remaining));
			return used + data.length;
		};
		child.stdout.on("data", (data: Buffer) => { outputBytes = capture(output, data, outputBytes); });
		child.stderr.on("data", (data: Buffer) => { errorBytes = capture(errors, data, errorBytes); });
		const stop = (reason: "cancelled" | "timeout") => {
			if (stopping) return;
			status = reason;
			stopping = terminateTree(child.pid).finally(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
		};
		const abort = () => stop("cancelled");
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop("timeout"), (input.timeout ?? DEFAULT_PROCESS_TIMEOUT_SECONDS) * 1000);
		child.on("error", error => { status = "spawn_error"; spawnError = error.message; });
		child.on("close", code => {
			clearTimeout(timer); signal?.removeEventListener("abort", abort);
			void Promise.resolve(stopping).then(() => resolve({ exit_code: code, status,
				stdout: Buffer.concat(output).toString("utf8"), stderr: spawnError ?? Buffer.concat(errors).toString("utf8"),
				truncated, duration_ms: Math.round((performance.now() - started) * 100) / 100 }));
		});
		if (signal?.aborted) abort();
	});
}

async function resolveProgram(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
	if (!argv.length || argv.some(arg => arg.includes("\0"))) throw new Error("argv 必须是无 NUL 的程序及参数数组。");
	const [program = "", ...args] = argv;
	const name = path.basename(program).toLowerCase().replace(/\.(exe|cmd|bat)$/u, "");
	if (["powershell", "pwsh", "bash", "sh", "cmd", "curl", "wget"].includes(name))
		throw new Error("不支持 Shell/curl 包装。请用 argv、cwd、env 编排程序；HTTP 使用 http()。");
	if (process.platform !== "win32") return [...argv];
	const lookupPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
	if (name === "npm" || name === "npx") {
		const launcher = /[\\/]/u.test(program) ? path.resolve(cwd, program) : await which(`${name}.cmd`, { path: lookupPath });
		const cli = path.join(path.dirname(launcher), `node_modules/npm/bin/${name}-cli.js`);
		await fs.access(cli);
		const adjacentNode = path.join(path.dirname(launcher), "node.exe");
		const node = await fs.access(adjacentNode).then(() => adjacentNode, () => which("node.exe", { path: lookupPath }));
		return [node, cli, ...args];
	}
	if (name === "gradlew") {
		if (env.JAVA_OPTS || env.GRADLE_OPTS) throw new Error("不展开 JAVA_OPTS/GRADLE_OPTS 字符串；请直接传 java 参数数组。");
		const wrapper = path.join(path.dirname(path.resolve(cwd, program)), "gradle/wrapper/gradle-wrapper.jar");
		await fs.access(wrapper);
		const javaHome = Object.entries(env).find(([key]) => key.toLowerCase() === "java_home")?.[1];
		return [javaHome ? path.join(javaHome, "bin/java.exe") : "java", "-Xmx64m", "-Xms64m", "-Dorg.gradle.appname=gradlew", "-classpath", wrapper, "org.gradle.wrapper.GradleWrapperMain", ...args];
	}
	if (/\.(cmd|bat)$/iu.test(program)) throw new Error("批处理入口需要 Shell；请改用实际 exe、JS CLI 或 Java 主类。");
	return [...argv];
}

async function terminateTree(pid: number | undefined): Promise<void> {
	if (pid === undefined) return;
	if (process.platform !== "win32") {
		try { process.kill(-pid, "SIGKILL"); } catch { /* 进程组可能已退出。 */ }
		return;
	}
	await new Promise<void>(resolve => {
		const taskkill = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe");
		const killer = spawn(taskkill, ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
		killer.once("error", () => resolve()); killer.once("close", () => resolve());
	});
}
