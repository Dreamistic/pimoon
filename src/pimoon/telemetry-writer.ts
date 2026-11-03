import fs from "node:fs/promises";
import path from "node:path";
import { retainStoragePath } from "../harness/storage/active.ts";

export type TelemetryFailure = "total_limit" | "queue_limit" | "write_error" | "serialization_error" | "checkpoint_error" | "late_event";

/** 有界事件队列；独立检查点不占事件配额，触顶后仍能说明记录缺失。 */
export class TelemetryWriter {
	private queue: string[] = [];
	private pendingBytes = 0;
	private acceptedBytes = 0;
	private writtenBytes = 0;
	private acceptedRecords = 0;
	private writtenRecords = 0;
	private droppedRecords = 0;
	private writes = 0;
	private ioMs = 0;
	private checkpointMs = 0;
	private failure: TelemetryFailure | undefined;
	private closed = false;
	private closing: Promise<void> | undefined;
	private checkpoint = Promise.resolve();
	private scheduled: NodeJS.Timeout | undefined;
	private writing: Promise<void> | undefined;
	private readonly release: () => void;

	constructor(
		private readonly output: string,
		private readonly onFailure: () => void,
		private readonly limits = { totalBytes: 64 * 1024 * 1024, pendingBytes: 1024 * 1024 },
	) {
		this.release = retainStoragePath(output);
	}

	get stats() {
		return { complete: this.failure === undefined, failure: this.failure, closed: this.closed,
			pendingBytes: this.pendingBytes, acceptedBytes: this.acceptedBytes, writtenBytes: this.writtenBytes,
			acceptedRecords: this.acceptedRecords, writtenRecords: this.writtenRecords, droppedRecords: this.droppedRecords,
			writes: this.writes, ioMs: this.ioMs, checkpointMs: this.checkpointMs };
	}

	reject(): void { this.droppedRecords++; }

	fail(reason: TelemetryFailure): void {
		if (this.failure !== undefined) return;
		this.failure = reason;
		this.onFailure();
	}

	append(line: string): void {
		if (this.failure !== undefined) { this.reject(); return; }
		if (this.closed) { this.reject(); this.fail("late_event"); return; }
		const size = Buffer.byteLength(line);
		if (this.acceptedBytes + size > this.limits.totalBytes || this.pendingBytes + size > this.limits.pendingBytes) {
			this.reject();
			this.fail(this.acceptedBytes + size > this.limits.totalBytes ? "total_limit" : "queue_limit");
			return;
		}
		this.queue.push(line);
		this.acceptedRecords++;
		this.acceptedBytes += size;
		this.pendingBytes += size;
		if (this.scheduled === undefined && this.writing === undefined) {
			this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.flush(); }, 25);
		}
	}

	async flush(): Promise<void> {
		clearTimeout(this.scheduled);
		this.scheduled = undefined;
		while (this.writing !== undefined || this.queue.length > 0) {
			if (this.writing === undefined) {
				const batch = this.queue.join(""), records = this.queue.length;
				this.queue = [];
				this.writing = this.write(batch, records).finally(() => { this.writing = undefined; });
			}
			await this.writing;
		}
		// 与其他 flush 串行更新，避免旧检查点覆盖新状态。
		this.checkpoint = this.checkpoint.then(async () => {
			const file = `${this.output}.status.json`, started = performance.now();
			try {
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.writeFile(`${file}.tmp`, JSON.stringify({ schema: 1, at: new Date().toISOString(), ...this.stats }), { mode: 0o600 });
				await fs.rename(`${file}.tmp`, file);
			} catch { this.fail("checkpoint_error"); }
			finally { this.checkpointMs += performance.now() - started; }
		});
		await this.checkpoint;
	}

	close(): Promise<void> {
		this.closing ??= (async () => {
			this.closed = true;
			try { await this.flush(); }
			finally { this.release(); }
		})();
		return this.closing;
	}

	private async write(batch: string, records: number): Promise<void> {
		const size = Buffer.byteLength(batch), started = performance.now();
		try {
			await fs.mkdir(path.dirname(this.output), { recursive: true });
			await fs.appendFile(this.output, batch, { mode: 0o600 });
			this.writtenBytes += size;
			this.writtenRecords += records;
			this.writes++;
		} catch {
			this.fail("write_error");
			this.pendingBytes -= this.queue.reduce((total, line) => total + Buffer.byteLength(line), 0);
			this.queue = [];
		} finally {
			this.pendingBytes -= size;
			this.ioMs += performance.now() - started;
		}
	}
}
