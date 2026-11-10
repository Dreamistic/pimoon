import path from "node:path";
import { MutationQueue } from "../../../harness/filesystem/platform/node/mutation-queue.ts";
import { replaceConfigFile } from "../../../harness/config-file.ts";
import { readBridgeFile } from "./files.ts";
import { parseBridge, tasksSchema, type BridgeTask } from "./schema.ts";

const parseTasks = parseBridge<BridgeTask[]>(tasksSchema);
export class BridgeStore {
	private value: BridgeTask[] = [];
	private original = "";
	private readonly queue = new MutationQueue();
	readonly file: string;
	constructor(directory: string) { this.file = path.join(directory, "tasks.json"); }
	get tasks(): readonly BridgeTask[] { return this.value; }
	async load(): Promise<void> {
		this.original = await readBridgeFile(this.file);
		this.value = this.original ? parseTasks(JSON.parse(this.original)) : [];
		if (new Set(this.value.map(task => task.id)).size !== this.value.length) throw new Error("桥接任务 ID 重复。");
	}
	change<T>(operation: (tasks: BridgeTask[]) => T): Promise<T> {
		return this.queue.run(this.file, undefined, async () => {
			const tasks = structuredClone(this.value), result = operation(tasks);
			const content = JSON.stringify(parseTasks(tasks), null, 2) + "\n";
			if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error("桥接任务记录已达到容量上限。");
			await replaceConfigFile(this.file, this.original, content);
			this.original = content; this.value = tasks;
			return result;
		});
	}
}
