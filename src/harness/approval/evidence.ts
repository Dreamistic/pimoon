import { installedGit } from "./routine-repository.ts";
import { within } from "./routine-paths.ts";
import type { BlockPlan } from "./block-plan.ts";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ApprovalRequest } from "./types.ts";
import { boundedText } from "./advisor-context.ts";

/** 固定只读探针，不执行模型生成的命令；事实绑定采集目标，不能推导别的目录。 */
export async function collectApprovalEvidence(request: ApprovalRequest, signal: AbortSignal, workspace = request.cwd): Promise<unknown[]> {
	const observedAt = new Date().toISOString();
	const evidence: unknown[] = [{ source: "host", observedAt, cwd: request.cwd,
		containment: "ordinary host; approval is not an OS sandbox; executable contents are not pinned" }];
	if (request.tool !== "process_run" && request.tool !== "bash") return evidence;
	const argv = request.tool === "process_run" ? request.detail.argv : [];
	const executable = path.basename(argv[0] ?? "").replace(/\.exe$/iu, "").toLowerCase();
	if (executable === "git") {
		let target = request.cwd;
		for (let i = 1; i < argv.length; i++) if (argv[i] === "-C" && argv[i + 1]) { target = path.resolve(target, argv[i + 1] ?? ""); i++; }
		const results = await Promise.all(["status", "remote"].map(async kind => ({ source: "host", observedAt, target,
			kind: kind === "status" ? "gitStatus" : "gitRemotes", repositoryVisibility: "unknown",
			...await git(target, kind === "status" ? ["status", "--porcelain=v1", "--untracked-files=normal"] : ["remote", "-v"], signal) })));
		evidence.push(...results);
	}
	// 仅补充参数明确指向的工作区内脚本与任务清单；不递归扫描、不读取凭据。
	const candidates = argv.slice(1).filter(arg => !arg.startsWith("-") && /\.(?:[cm]?[jt]s|tsx|py|ps1|sh|cmd|bat)$/iu.test(arg)).slice(0, 3);
	if (["npm", "pnpm", "yarn", "bun"].includes(executable)) candidates.push("package.json");
	for (const candidate of candidates) {
		signal.throwIfAborted();
		try {
			const root = await realpath(workspace), target = await realpath(path.resolve(request.cwd, candidate));
			const relative = path.relative(root, target);
			if (!within(root, target) || relative.startsWith("..") || path.isAbsolute(relative)) { evidence.push({ source: "host", kind: "script", path: candidate, content: "outside cwd; not collected" }); continue; }
			const info = await stat(target);
			if (!info.isFile() || info.size > 128000) { evidence.push({ source: "host", kind: "script", path: target, content: "not a bounded text file" }); continue; }
			const content = await readFile(target, { encoding: "utf8", signal });
			evidence.push({ source: "host", kind: "script", observedAt, path: target,
				sha256: createHash("sha256").update(content).digest("hex"), ...boundedText(content, 24000), contentTrust: "untrusted file data", pinnedForExecution: false });
		} catch (error) {
			signal.throwIfAborted();
			evidence.push({ source: "host", kind: "script", path: candidate, available: false });
		}
	}
	return evidence;
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<{ available: boolean; text: string; truncated: boolean }> {
	const executable = await installedGit(cwd);
	if (!executable) return { available: false, text: "", truncated: false };
	return new Promise(resolve => {
		execFile(executable, ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { signal, windowsHide: true, timeout: 3000, maxBuffer: 64000,
			env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
			// URL 内嵌认证不进入证据，保留目标主机与仓库路径。
			const safe = stdout.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gu, "$1[redacted]@");
			resolve({ available: error === null, ...boundedText(safe, 16000) });
		});
	});
}


/** 后续确定进程也提供有界文件快照，不能把“第一项安全”外推为整段安全。 */
export async function collectBlockEvidence(request: ApprovalRequest, plan: BlockPlan | undefined, workspace: string, signal: AbortSignal): Promise<unknown[]> {
	const evidence = await collectApprovalEvidence(request, signal, workspace);
	const seen = new Set<string>(request.tool === "process_run" ? [JSON.stringify({ argv: request.detail.argv, cwd: request.cwd })] : []);
	let inspected = 0, chars = JSON.stringify(evidence).length, omitted = 0;
	for (const call of plan?.calls ?? []) {
		if (call.tool !== "process_run" || !Array.isArray(call.input.argv) || !call.input.argv.every((arg): arg is string => typeof arg === "string")) continue;
		const cwd = typeof call.input.cwd === "string" ? path.resolve(workspace, call.input.cwd) : workspace;
		const key = JSON.stringify({ argv: call.input.argv, cwd }); if (seen.has(key)) continue; seen.add(key);
		if (inspected >= 4 || chars >= 96000) { omitted++; continue; }
		inspected++;
		const detail = { argv: call.input.argv, env: {} };
		const rows = await collectApprovalEvidence({ tool: "process_run", cwd, units: [], detail }, signal, workspace);
		const size = JSON.stringify(rows).length;
		if (chars + size > 96000) { omitted++; continue; }
		chars += size; evidence.push({ source: "host", kind: "planned_process", line: call.line, snapshots: rows, parametersPinned: false });
	}
	if (omitted) evidence.push({ source: "host", kind: "plan_evidence_omitted", count: omitted, content: "unknown; not verified safe" });
	return evidence;
}
