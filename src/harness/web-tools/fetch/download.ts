import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { MutationQueue } from "../../filesystem/platform/node/mutation-queue.ts";
import { checkWritablePath } from "../../../pimoon/paths.ts";
import { protectedCredentialPaths } from "../../../pimoon/profile.ts";

const downloads = new MutationQueue();

/** 全程持有目标写入队列；只提交完整的新文件，取消或失败删除临时文件。 */
export async function downloadFile<T>(workspace: string, destination: string, signal: AbortSignal | undefined,
	fetch: (onChunk: (chunk: Uint8Array) => Promise<void>) => Promise<T>): Promise<T> {
	return downloads.run(destination, signal, async () => {
		await checkWritablePath(workspace, destination, protectedCredentialPaths);
		await fs.lstat(destination).then(() => { throw new Error("Download destination exists; choose a new path."); }, (error: unknown) => {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		});
		signal?.throwIfAborted();
		const temporary = `${destination}.${randomUUID()}.tmp`;
		const file = await fs.open(temporary, "wx");
		try {
			const result = await fetch(async chunk => { signal?.throwIfAborted(); await file.writeFile(chunk); });
			await file.close();
			await checkWritablePath(workspace, destination, protectedCredentialPaths);
			signal?.throwIfAborted();
			// 硬链接原子创建目标；竞态中出现的已有文件也不覆盖。
			await fs.link(temporary, destination);
			return result;
		} finally {
			try { await file.close(); }
			finally { await fs.rm(temporary, { force: true }); }
		}
	});
}
