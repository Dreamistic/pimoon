import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { resolveNativeInputPath } from "../filesystem/kernel/access-policy.ts";

export function within(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 只判定可核验的本地路径，不推断正文语义；拒绝不等于阻止操作，而是交给 AI。 */
export async function routinePath(root: string, input: string, write = false): Promise<boolean> {
	if (!input || input.includes("://") || /^(?:\\\\|\/\/)/u.test(input)) return false;
	const absolute = resolveNativeInputPath(root, input);
	if (/^(?:\\\\|\/\/)/u.test(absolute) || !within(root, absolute) || sensitivePath(path.relative(root, absolute), write)) return false;
	try {
		const canonicalRoot = await realpath(root);
		let ancestor = absolute;
		for (;;) {
			try {
				const info = await lstat(ancestor);
				if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) return false;
				const canonical = path.join(await realpath(ancestor), path.relative(ancestor, absolute));
				return within(canonicalRoot, canonical) && !sensitivePath(path.relative(canonicalRoot, canonical), write);
			} catch (error) {
				if (!missing(error)) return false;
				// 悬空链接不能作为缺失的新文件；lstat 已在 realpath 之前检查。
				if (ancestor === root) return false;
				const parent = path.dirname(ancestor);
				if (parent === ancestor) return false;
				ancestor = parent;
			}
		}
	} catch { return false; }
}

export function sensitivePath(relative: string, write: boolean): boolean {
	const parts = relative.replaceAll("\\", "/").toLowerCase().split("/");
	if (parts.some(part => [".git", ".private", ".ssh", ".aws", ".azure", ".kube", ".gnupg", ".pimoon", ".pi", ".docker", ".credentials", ".npmrc", ".pypirc", ".netrc"].includes(part)
		|| part === ".env" || part.startsWith(".env.") || /^(?:credentials?|secrets?)(?:[._-]|$)/u.test(part)
		|| /^(?:auth\.json|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$/u.test(part))) return true;
	if (!write) return false;
	return parts.some(part => ["node_modules", ".github", ".vscode", ".husky", "approval", "security", "auth", "permissions"].includes(part))
		|| parts.some(part => /^(?:package(?:-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|.*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|agents\.md|append_system\.md)$/u.test(part));
}

export function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
