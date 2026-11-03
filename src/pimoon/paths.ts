import fs from "node:fs/promises";
import path from "node:path";

const inside = (root: string, file: string): boolean => {
	const relative = path.relative(root, file);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
};
/** 路径检查是纵深防御，不是对抗并发换链的沙箱。 */
export async function checkWorkspacePath(cwd: string, target: string): Promise<void> {
	const root = await fs.realpath(cwd);
	let candidate = path.resolve(cwd, target);
	if (!inside(path.resolve(cwd), candidate)) throw new Error("仅允许当前工作区路径。");
	for (;;) {
		try { if (!inside(root, await fs.realpath(candidate))) throw new Error("路径链接指向工作区外。"); return; }
		catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			const parent = path.dirname(candidate);
			if (parent === candidate) throw error;
			candidate = parent;
		}
	}
}
