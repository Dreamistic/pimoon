import path from "node:path";
import type { ApprovalRequest } from "./types.ts";
import { installedGit } from "./routine-repository.ts";
import { routinePath } from "./routine-paths.ts";

const PREFIX = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false"];
const FLAGS: Record<string, ReadonlySet<string>> = {
	status: new Set(["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all", "--ignored", "--ignored=matching"]),
	diff: new Set(["--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--check", "--cached", "--staged", "--summary", "--quiet", "--exit-code", "--no-color", "--no-ext-diff", "--no-textconv"]),
	log: new Set(["--oneline", "--all", "--decorate", "--no-decorate", "--stat", "--name-only", "--no-patch", "--no-color"]),
	show: new Set(["--stat", "--name-only", "--no-patch", "--format=fuller", "--no-color", "--no-ext-diff", "--no-textconv"]),
	"rev-parse": new Set(["--show-toplevel", "--git-common-dir", "--git-dir", "--is-inside-work-tree", "--short", "--verify", "--path-format=absolute"]),
	"ls-files": new Set(["--cached", "--modified", "--others", "--exclude-standard", "--stage", "-z"]),
};

/** argv 限定到查询语法；不接受 -c、-C、环境注入、输出文件、外部 diff 或任意别名。 */
export async function routineGit(request: ApprovalRequest, workspace: string): Promise<boolean> {
	if (request.tool !== "process_run" || Object.keys(request.detail.env).length) return false;
	const [program, command, ...args] = request.detail.argv;
	if (program !== "git" && program !== "git.exe" || !command || !FLAGS[command]) return false;
	if (!await routinePath(workspace, request.cwd)) return false;
	if (!await installedGit(workspace)) return false;
	const inherited = request.detail.inherit_env === false ? {} : process.env;
	if (Object.keys(inherited).some(key => /^(?:GIT_|LD_PRELOAD$|DYLD_)/iu.test(key))) return false;
	let paths = false;
	for (const arg of args) {
		if (arg === "--" && !paths) { paths = true; continue; }
		if (paths) {
			if (arg.startsWith(":") || !await routinePath(workspace, path.resolve(request.cwd, arg))) return false;
			continue;
		}
		if (FLAGS[command].has(arg)) continue;
		if (["log", "show"].includes(command) && /^(?:-[1-9][0-9]{0,3}|--max-count=[1-9][0-9]{0,3}|--format=(?:%h|%H|%s|%h %s))$/u.test(arg)) continue;
		if (["diff", "log", "show", "rev-parse"].includes(command) && /^(?:HEAD(?:[~^][0-9]*)?|[a-f0-9]{7,40}|main|master)(?:\.\.(?:HEAD|main|master))?$/u.test(arg)) continue;
		return false;
	}
	return true;
}

/** 查询使用同一 argv；强制项放在最后一个配置位置，不能被仓库 pager/fsmonitor 覆盖。 */
export function guardedGitArgv(argv: readonly string[]): string[] {
	const [program = "git", command = "", ...args] = argv;
	return [program, ...PREFIX, command, ...(["diff", "log", "show"].includes(command) ? ["--no-ext-diff", "--no-textconv"] : []), ...args];
}
