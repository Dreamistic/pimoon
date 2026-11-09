import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ApprovalRequest } from "./types.ts";
import { boundedText } from "./advisor-context.ts";

/** 固定只读探针，不执行模型生成的命令；事实绑定采集目标，不能推导别的目录。 */
export async function collectApprovalEvidence(request: ApprovalRequest, signal: AbortSignal): Promise<unknown[]> {
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
			const root = await realpath(request.cwd), target = await realpath(path.resolve(request.cwd, candidate));
			const relative = path.relative(root, target);
			if (relative.startsWith("..") || path.isAbsolute(relative)) { evidence.push({ source: "host", kind: "script", path: candidate, content: "outside cwd; not collected" }); continue; }
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

function git(cwd: string, args: string[], signal: AbortSignal): Promise<{ available: boolean; text: string; truncated: boolean }> {
	return new Promise(resolve => {
		execFile("git", ["--no-optional-locks", "-C", cwd, ...args], { signal, windowsHide: true, timeout: 3000, maxBuffer: 64000,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
			// URL 内嵌认证不进入证据，保留目标主机与仓库路径。
			const safe = stdout.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gu, "$1[redacted]@");
			resolve({ available: error === null, ...boundedText(safe, 16000) });
		});
	});
}
