import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./schema.ts";

export function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
export async function readBridgeFile(file: string, limit = 8 * 1024 * 1024): Promise<string> {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new Error("桥接记录不是受限普通文件。");
		return await readFile(file, "utf8");
	} catch (error) { if (missing(error)) return ""; throw error; }
}

/** 锁覆盖整个宿主生命周期；只清除已退出进程留下的锁。 */
export async function lockBridge(directory: string): Promise<() => Promise<void>> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("桥接目录不能是链接。");
	const file = path.join(directory, "host.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(file, "wx", 0o600);
			try { await handle.writeFile(JSON.stringify({ pid: process.pid })); } finally { await handle.close(); }
			return async () => { await unlink(file); };
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST" || attempt) throw error;
			const value: unknown = JSON.parse(await readBridgeFile(file, 1024));
			if (!value || typeof value !== "object" || !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)
				throw new Error("无效桥接宿主锁，请检查旧宿主状态。");
			try { process.kill(value.pid, 0); }
			catch (probe) {
				if (probe instanceof Error && "code" in probe && probe.code === "ESRCH") { await unlink(file); continue; }
				throw probe;
			}
			throw new BridgeError(409, "已有桥接宿主占用此配置目录。");
		}
	}
	throw new Error("无法获取桥接宿主锁。");
}
