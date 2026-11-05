import { availableParallelism } from "node:os";
import { WorkerTaskAbortedError } from "../../worker-runtime/worker-task-pool.ts";

export const FILE_SCAN_CONCURRENCY = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));

/** 一个 grep owner 的所有查询共用文件扫描预算，取消只移除自己的排队项。 */
export class GrepScanBudget {
	private active = 0;
	private readonly waiting = new Set<() => void>();

	async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw new WorkerTaskAbortedError();
		await new Promise<void>((resolve, reject) => {
			const start = () => {
				signal?.removeEventListener("abort", cancel);
				this.active++;
				resolve();
			};
			const cancel = () => {
				this.waiting.delete(start);
				signal?.removeEventListener("abort", cancel);
				reject(new WorkerTaskAbortedError());
			};
			if (this.active < FILE_SCAN_CONCURRENCY) start();
			else { this.waiting.add(start); signal?.addEventListener("abort", cancel, { once: true }); }
		});
		try {
			if (signal?.aborted) throw new WorkerTaskAbortedError();
			return await task();
		} finally {
			this.active--;
			const next = this.waiting.values().next().value;
			if (next) { this.waiting.delete(next); next(); }
		}
	}
}
