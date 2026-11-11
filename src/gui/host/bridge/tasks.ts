import path from "node:path";
import { mkdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { GuiHost } from "../host.ts";
import type { GuiClient } from "../client.ts";
import { MutationQueue } from "../../../harness/filesystem/platform/node/mutation-queue.ts";
import { gitRoot, gitOutput, runGit } from "../workspace/workspace-git.ts";
import { BridgeStore } from "./store.ts";
import { BridgeEvents } from "./events.ts";
import { taskSnapshot } from "./snapshot.ts";
import { BridgeError, parseSubmit, parseMessage, parseReview, parseDialog, parseDelivery, type BridgeTask } from "./schema.ts";

const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const finished = (state: string) => ["lost", "accepted", "cancelled"].includes(state);
export class BridgeTasks {
	readonly events = new BridgeEvents();
	readonly store: BridgeStore;
	private readonly client: GuiClient;
	private readonly mutations = new MutationQueue();
	private readonly lifetime = new AbortController();
	private readonly background = new Set<Promise<void>>();
	private readonly fingerprints = new Map<string, string>();
	private lastPoll = 0;
	private closed = false;
	constructor(private readonly host: GuiHost, readonly directory: string) {
		this.store = new BridgeStore(directory);
		this.client = host.createClient(undefined, "delegate");
	}
	async load(): Promise<void> { await this.store.load(); for (const task of this.store.tasks) this.changed(task.id); }
	changed(id: string): void { if (this.store.tasks.some(task => task.id === id)) this.events.changed(id); }
	suppressNotification(id: string): boolean { return !this.closed && this.lastPoll > 0 && Date.now() - this.lastPoll < 60000 && this.store.tasks.some(task => task.id === id); }
	private assertOpen(): void { if (this.closed) throw new BridgeError(503, "桥接已关闭。"); }
	private record(id: string): BridgeTask {
		const task = this.store.tasks.find(task => task.id === id);
		if (!task) throw new BridgeError(404, "委派任务不存在。");
		return task;
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		return this.mutations.run(this.directory, this.lifetime.signal, async () => { this.assertOpen(); return operation(); });
	}
	async get(id: string) { this.assertOpen(); return taskSnapshot(this.record(id), this.host.sessions.get(id)); }
	async list() { this.assertOpen(); return Promise.all(this.store.tasks.map(task => taskSnapshot(task, this.host.sessions.get(task.id)))); }
	polled(): void { this.lastPoll = Date.now(); }
	private async refresh(): Promise<void> {
		for (const task of await this.list()) {
			const fingerprint = JSON.stringify([task.state, task.dialogs, task.delivery, task.verdict, task.lastError, task.lastMessageId]);
			if (this.fingerprints.get(task.id) !== fingerprint) { this.fingerprints.set(task.id, fingerprint); this.changed(task.id); }
		}
	}
	async poll(after: number, wait: number, signal: AbortSignal) {
		this.polled(); await this.refresh();
		await this.events.poll(after, wait, signal);
		await this.refresh();
		return this.events.poll(after, 0, signal);
	}
	private async head(cwd: string): Promise<string | null> {
		const value = await runGit(cwd, ["rev-parse", "--verify", "HEAD"], this.lifetime.signal);
		if (value.code === 0) return value.stdout.trim();
		if (value.code === 1 || value.code === 128) return null;
		throw new Error(value.stderr.trim());
	}
	submit(value: unknown): Promise<{ id: string }> {
		const input = parseSubmit(value);
		return this.serial(async () => {
			if (!path.isAbsolute(input.cwd)) throw new BridgeError(400, "工作目录必须是绝对路径。");
			const cwd = await realpath(input.cwd);
			if (!(await stat(cwd)).isDirectory()) throw new BridgeError(400, "工作目录不是文件夹。");
			const root = await gitRoot(cwd, this.lifetime.signal), repository = root ? await realpath(root) : cwd;
			for (const task of this.store.tasks) if (key(task.repository) === key(repository) && !finished((await this.get(task.id)).state))
				throw new BridgeError(409, "此仓库已有未结束的委派任务。", task.id);
			const [head, status] = root ? await Promise.all([this.head(repository), gitOutput(repository, ["status", "--porcelain=v1", "--untracked-files=normal"], this.lifetime.signal)]) : [null, ""];
			const manager = SessionManager.create(cwd);
			manager.appendSessionInfo(`delegate: ${input.title ?? input.goal.slice(0, 80)}`);
			const sessionFile = manager.getSessionFile(), header = manager.getHeader();
			if (!sessionFile || !header) throw new Error("无法创建委派会话。");
			// 普通空白会话不落盘；委派先保存有效头与名称，保证启动中崩溃也不会误判 lost。
			await mkdir(path.dirname(sessionFile), { recursive: true });
			await writeFile(sessionFile, [header, ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
			const task: BridgeTask = { id: manager.getSessionId(), sessionFile, cwd, repository, createdAt: new Date().toISOString(),
				brief: { goal: input.goal, acceptance: input.acceptance, constraints: input.constraints }, base: { head, dirty: status.length > 0 },
				delivery: null, verdict: null, cancelled: false, history: [], lastError: null };
			try { await this.store.change(tasks => { tasks.push(task); }); }
			catch (error) { await unlink(sessionFile); throw error; }
			this.host.register(SessionManager.open(sessionFile), { type: "session_start", reason: "new" });
			this.host.refresh();
			this.launch(task, `Delegated task\n${JSON.stringify(task.brief)}`);
			this.changed(task.id);
			return { id: task.id };
		});
	}
	private launch(task: BridgeTask, text: string): void {
		// dispatch 等待整轮；HTTP 只等待入场与记录，错误异步写回同一任务。
		const pending = (async () => {
			const session = this.host.sessions.get(task.id); if (!session) throw new Error("委派会话不存在。");
			const execution = await session.ensure(this.client.forSession(session));
			// abort 无法撤回已等待启动的 Promise；恢复后必须再检查任务是否仍允许入场。
			if (this.closed || this.record(task.id).cancelled || this.record(task.id).verdict?.verdict === "accepted") return;
			await this.client.dispatch({ action: "prompt", text, images: [], behavior: "steer" }, task.id);
			const last = execution.idle ? execution.runtime.session.messages.findLast(message => message.role === "assistant") : undefined;
			if (last?.role === "assistant" && last.stopReason === "error") throw new Error(last.errorMessage ?? "Model response failed.");
		})()
			.catch(async (error: unknown) => {
				await this.store.change(tasks => { const current = tasks.find(value => value.id === task.id); if (current) current.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 2000); });
			}).catch((error: unknown) => this.host.reportError(error))
			.finally(() => { this.background.delete(pending); this.changed(task.id); });
		this.background.add(pending);
	}
	private async live(id: string): Promise<BridgeTask> {
		const task = this.record(id), view = await this.get(id);
		if (finished(view.state)) throw new BridgeError(409, "委派任务已结束或会话已丢失。", id);
		const session = this.host.sessions.get(id) ?? await this.host.openFile(task.sessionFile);
		if (session.id !== id) throw new BridgeError(409, "委派会话文件已被替换。", id);
		return task;
	}
	message(id: string, value: unknown): Promise<void> {
		const { text } = parseMessage(value);
		if (!text.trim() || /^\s*[!/]/u.test(text)) throw new BridgeError(400, "委派消息必须是普通文本，不能执行界面或 shell 命令。");
		return this.serial(async () => {
			const task = await this.live(id);
			if (task.delivery) throw new BridgeError(409, "请先验收或打回当前交付。", id);
			await this.store.change(tasks => { const current = tasks.find(value => value.id === id); if (current) current.lastError = null; });
			this.launch(task, text);
		});
	}
	async answer(id: string, dialogId: string, value: unknown): Promise<void> {
		const reply = parseDialog(value); this.assertOpen(); this.record(id);
		const session = this.host.sessions.get(id), dialog = session?.execution?.dialogs.list().find(dialog => dialog.id === dialogId);
		if (!dialog) throw new BridgeError(409, "对话框已结束，请重新查询任务。");
		if (dialog.kind === "secret" || dialog.kind === "editor") throw new BridgeError(403, "此对话框需要用户应答。");
		try { await this.client.dispatch({ action: "dialog", id: dialogId, ...reply }, id); }
		catch (error) {
			if (!session?.execution?.dialogs.list().some(dialog => dialog.id === dialogId)) throw new BridgeError(409, "对话框已结束，请重新查询任务。");
			throw new BridgeError(400, error instanceof Error ? error.message : String(error));
		}
	}
	review(id: string, value: unknown): Promise<void> {
		const input = parseReview(value);
		if (input.verdict === "rejected" && !input.feedback?.trim()) throw new BridgeError(400, "打回交付必须提供意见。");
		return this.serial(async () => {
			const task = await this.live(id);
			if ((await this.get(id)).state !== "delivered" || !task.delivery) throw new BridgeError(409, "当前没有可验收的交付。", id);
			const at = new Date().toISOString();
			await this.store.change(tasks => {
				const current = tasks.find(value => value.id === id); if (!current) throw new BridgeError(404, "任务不存在。");
				current.verdict = { ...input, at };
				if (input.verdict === "rejected" && current.delivery) {
					current.history.push({ delivery: current.delivery, feedback: input.feedback?.trim() ?? "", at });
					current.delivery = null; current.lastError = null;
				}
			});
			if (input.verdict === "rejected") this.launch(task, `Delivery rejected. Address the review feedback:\n${input.feedback}`);
			this.changed(id);
		});
	}
	cancel(id: string): Promise<void> {
		return this.serial(async () => {
			const task = this.record(id);
			if (task.verdict?.verdict === "accepted") throw new BridgeError(409, "已验收任务不能取消。", id);
			await this.store.change(tasks => { const current = tasks.find(value => value.id === id); if (current) current.cancelled = true; });
			if (this.host.sessions.get(id)?.execution) await this.client.dispatch({ action: "abort" }, id);
			this.changed(id);
		});
	}
	recordDelivery(id: string, value: unknown): Promise<void> {
		const input = parseDelivery(value);
		return this.serial(async () => {
			const task = await this.live(id), head = await this.head(task.cwd);
			await this.store.change(tasks => { const current = tasks.find(value => value.id === id); if (!current) throw new BridgeError(404, "任务不存在。");
				current.delivery = { ...input, head, at: new Date().toISOString() }; current.verdict = null; current.lastError = null; });
			this.changed(id);
		});
	}
	stop(): void { this.closed = true; this.lifetime.abort(); this.events.close(); }
	async close(): Promise<void> {
		this.stop();
		await this.mutations.run(this.directory, undefined, async () => {});
		await Promise.allSettled(this.store.tasks.filter(task => this.host.sessions.get(task.id)?.execution).map(task => this.client.dispatch({ action: "abort" }, task.id)));
		await Promise.allSettled([...this.background]);
		this.client.close(); this.mutations.dispose();
	}
}
