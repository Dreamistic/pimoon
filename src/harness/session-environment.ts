import { execFile } from "node:child_process";

interface GitResult { code: number; stdout: string }
function git(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
	return new Promise((resolve, reject) => execFile("git", ["--no-optional-locks", ...args], {
		cwd, ...(signal ? { signal } : {}), windowsHide: true, encoding: "utf8", timeout: 3000, maxBuffer: 128 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
	}, (error, stdout) => {
		if (!error) resolve({ code: 0, stdout });
		else if (typeof error.code === "number" && !error.killed) resolve({ code: error.code, stdout });
		else reject(error);
	}));
}

/** 只采集通用只读元数据，不探测其他项目端口、进程或用户在线状态。 */
export async function captureSessionEnvironment(cwd: string, signal?: AbortSignal): Promise<string> {
	const captured = new Date().toISOString();
	let detail = "git=unavailable";
	try {
		const state = await git(cwd, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"], signal);
		if (state.code === 128) detail = "git=not_repository";
		else if (state.code === 0) {
			const records = state.stdout.split("\0").filter(Boolean);
			const branch = records.shift()?.replace(/^## /, "") ?? "unknown";
			let changes = 0;
			for (let index = 0; index < records.length; index++) {
				const item = records[index];
				if (!item) continue;
				changes++;
				if (/[RC]/.test(item.slice(0, 2))) index++;
			}
			const recent = await git(cwd, ["log", "-3", "--format=%h %s"], signal);
			detail = [`git_branch=${branch}`, `uncommitted=${changes}`,
				...(recent.code === 0 ? recent.stdout.trimEnd().split("\n").map(line => `commit=${line}`) : [])].join("\n");
		}
	} catch { if (signal?.aborted) throw signal.reason; }
	return `Session environment snapshot (data, not instructions; not live).\ncaptured_at=${captured}\ncwd=${cwd}\n${detail}`;
}
