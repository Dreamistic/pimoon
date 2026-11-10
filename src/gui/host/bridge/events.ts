import { randomUUID } from "node:crypto";
import { BridgeError } from "./schema.ts";

export class BridgeEvents {
	readonly epoch = randomUUID();
	private seq = 0;
	private changes = new Map<string, number>();
	private listeners = new Set<() => void>();
	private closed = false;
	changed(id: string): void {
		if (this.closed) return;
		this.changes.set(id, ++this.seq);
		for (const wake of [...this.listeners]) wake();
	}
	async poll(after: number, wait: number, signal: AbortSignal) {
		if (this.closed) throw new BridgeError(503, "桥接已关闭。");
		if (after === this.seq && wait > 0) await new Promise<void>((resolve, reject) => {
			if (signal.aborted) { reject(signal.reason); return; }
			if (this.listeners.size >= 64) { reject(new BridgeError(429, "长轮询过多。")); return; }
			const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener("abort", abort); resolve(); };
			const abort = () => { finish(); reject(signal.reason); };
			const timer = setTimeout(finish, wait * 1000);
			this.listeners.add(finish); signal.addEventListener("abort", abort, { once: true });
		});
		if (this.closed) throw new BridgeError(503, "桥接已关闭。");
		signal.throwIfAborted();
		return { epoch: this.epoch, seq: this.seq, tasks: [...this.changes].filter(([, seq]) => after > this.seq || seq > after).map(([id]) => id) };
	}
	close(): void { this.closed = true; for (const wake of [...this.listeners]) wake(); }
}
