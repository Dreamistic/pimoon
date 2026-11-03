import fs from "node:fs/promises";
import path from "node:path";

const inside = (root: string, file: string): boolean => {
	const relative = path.relative(root, file);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
};
/** 读取不受工作区范围限制；同时检查原始路径和链接目标中的受保护路径。 */
export async function checkReadablePath(cwd: string, target: string, protectedPaths: readonly string[]): Promise<string> {
	const absolute = path.resolve(cwd, target);
	const canonical = await fs.realpath(absolute);
	for (const protectedPath of protectedPaths) {
		let resolved: string;
		try { resolved = await fs.realpath(protectedPath); }
		catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			resolved = path.resolve(protectedPath);
		}
		if ([absolute, canonical].some(file => inside(path.resolve(protectedPath), file) || inside(resolved, file)))
			throw new Error("不能读取受保护的凭据路径。");
	}
	return canonical;
}

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
