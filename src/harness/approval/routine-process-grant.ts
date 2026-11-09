import which from "which";
import { installedGit } from "./routine-repository.ts";
import { guardedGitArgv } from "./routine-git.ts";

const grants = new WeakMap<object, { fingerprint: string; executable: string; category: string }>();
const fingerprint = (input: object) => JSON.stringify(input);

export async function grantRoutineProcess(input: object, workspace: string, category: string): Promise<void> {
	const executable = category === "git_inspection" ? await installedGit(workspace) : await which("node");
	if (!executable) throw new Error("Routine executable could not be verified.");
	grants.set(input, { fingerprint: fingerprint(input), executable, category });
}

export function routineProcessArgv(input: object, argv: string[]): string[] {
	const expected = grants.get(input);
	grants.delete(input);
	if (expected === undefined) return argv;
	if (expected.fingerprint !== fingerprint(input)) throw new Error("Routine process parameters changed before execution.");
	const pinned = [expected.executable, ...argv.slice(1)];
	if (expected.category === "git_inspection") return guardedGitArgv(pinned);
	// noEmit 仍可能按 tsconfig 写入 tsbuildinfo；仅检查模式禁用该输出。
	return expected.category === "local_typecheck" ? [...pinned, "--incremental", "false", "--composite", "false"] : pinned;
}
