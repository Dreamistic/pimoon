interface MutationWaiter {
	settled: boolean;
	resolve(release: () => void): void;
	reject(error: MutationQueueUnavailableError): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}
interface MutationQueueEntry { readonly waiters: MutationWaiter[] }

export class MutationQueueUnavailableError extends Error {
	constructor(readonly reason: "aborted" | "disposed", options?: ErrorOptions) {
		super(reason === "aborted" ? "Mutation queue wait was aborted." : "Mutation queue is shut down.", options);
		this.name = "MutationQueueUnavailableError";
	}
}

// 各 FileToolsHost 共用目标队列，避免不同会话同时提交同一文件。
const entries = new Map<string, MutationQueueEntry>();

/** 每个实例只取消自己的等待者，提交队列跨会话共享。 */
export class MutationQueue {
	private readonly ownedWaiters = new Set<MutationWaiter>();
	private disposed = false;

	async run<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		const queueKey = process.platform === "win32" ? key.toLocaleLowerCase() : key;
		const release = await this.acquire(queueKey, signal);
		try {
			if (signal?.aborted === true) throw new MutationQueueUnavailableError("aborted", { cause: signal.reason });
			return await operation();
		} finally { release(); }
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const waiter of this.ownedWaiters) {
			waiter.settled = true;
			this.removeAbortListener(waiter);
			waiter.reject(new MutationQueueUnavailableError("disposed"));
		}
		this.ownedWaiters.clear();
	}

	private async acquire(key: string, signal: AbortSignal | undefined): Promise<() => void> {
		if (this.disposed) throw new MutationQueueUnavailableError("disposed");
		if (signal?.aborted === true) throw new MutationQueueUnavailableError("aborted", { cause: signal.reason });
		let entry = entries.get(key);
		if (entry === undefined) {
			entry = { waiters: [] }; entries.set(key, entry);
			return this.releaseFor(key, entry);
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter: MutationWaiter = {
				settled: false,
				resolve: release => { this.ownedWaiters.delete(waiter); resolve(release); },
				reject: error => { this.ownedWaiters.delete(waiter); reject(error); },
				...(signal === undefined ? {} : { signal }),
			};
			this.ownedWaiters.add(waiter);
			if (signal !== undefined) {
				waiter.onAbort = () => {
					waiter.settled = true;
					const index = entry.waiters.indexOf(waiter);
					if (index >= 0) entry.waiters.splice(index, 1);
					waiter.reject(new MutationQueueUnavailableError("aborted", { cause: signal.reason }));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			entry.waiters.push(waiter);
		});
	}

	private releaseFor(key: string, entry: MutationQueueEntry): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (entry.waiters.length > 0) {
				const waiter = entry.waiters.shift();
				if (waiter === undefined || waiter.settled) continue;
				waiter.settled = true; this.removeAbortListener(waiter);
				waiter.resolve(this.releaseFor(key, entry)); return;
			}
			if (entries.get(key) === entry) entries.delete(key);
		};
	}
	private removeAbortListener(waiter: MutationWaiter): void {
		if (waiter.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
	}
}
