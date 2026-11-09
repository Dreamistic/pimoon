import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import which from "which";
import { within } from "./routine-paths.ts";
const exec = promisify(execFile);

export async function installedGit(workspace: string): Promise<string | undefined> {
	try {
		const executable = await realpath(await which("git"));
		return within(await realpath(workspace), executable) ? undefined : executable;
	} catch { return; }
}

/** 仅检查目标是否被当前仓库跟踪；未跟踪既有文件不自动覆盖，不创建仓库或索引。 */
export async function trackedFile(workspace: string, target: string): Promise<boolean> {
	const executable = await installedGit(workspace);
	if (!executable) return false;
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	try {
		await exec(executable, ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", workspace,
			"ls-files", "--error-unmatch", "--", path.relative(workspace, target)], { env, windowsHide: true, timeout: 3000, maxBuffer: 64000 });
		return true;
	} catch { return false; }
}
