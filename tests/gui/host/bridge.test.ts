import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lockBridge } from "../../../src/gui/host/bridge/files.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { BridgeStore } from "../../../src/gui/host/bridge/store.ts";
import { BridgeEvents } from "../../../src/gui/host/bridge/events.ts";
import { taskState } from "../../../src/gui/host/bridge/snapshot.ts";
import type { BridgeTask } from "../../../src/gui/host/bridge/schema.ts";
import { pimoonHome, protectedCredentialPaths } from "../../../src/pimoon/profile.ts";
import { checkReadablePath, checkWritablePath } from "../../../src/pimoon/paths.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("bridge-state-");
const task = (): BridgeTask => ({ id: "fixture", sessionFile: "fixture.jsonl", cwd: "fixture", repository: "fixture", createdAt: "now",
	brief: { goal: "task", acceptance: [], constraints: [] }, base: { head: null, dirty: false }, delivery: null, verdict: null, cancelled: false, lastError: null, history: [] });
it("状态按会话文件、验收、取消、运行、等待、交付依次推导，状态不落盘", () => {
	const value = task();
	expect(taskState(value, true, "idle")).toBe("stalled");
	expect(taskState(value, true, "waiting")).toBe("waiting");
	expect(taskState(value, true, "loading")).toBe("running");
	value.delivery = { summary: "done", changes: [], verification: [], unverified: [], objections: [], head: "head", at: "now" };
	expect(taskState(value, true, "idle")).toBe("delivered");
	expect(taskState(value, true, "running")).toBe("running");
	expect(taskState(value, true, "waiting")).toBe("waiting");
	value.cancelled = true; expect(taskState(value, true, "running")).toBe("cancelled");
	value.verdict = { verdict: "accepted", at: "now" }; expect(taskState(value, true, "running")).toBe("accepted");
	expect(taskState(value, false, "running")).toBe("lost");
});
it("并发修改串行原子写入；失败不发布半成品，外部更改不被覆盖", async () => {
	const store = new BridgeStore(temp.path); await store.load();
	await store.change(tasks => { tasks.push(task()); });
	await Promise.all(["one", "two"].map(id => store.change(tasks => { tasks.push({ ...task(), id }); })));
	expect(JSON.parse(await readFile(store.file, "utf8"))).toHaveLength(3);
	const original = await readFile(store.file, "utf8");
	await expect(store.change(tasks => { tasks.length = 0; throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
	expect(store.tasks).toHaveLength(3); expect(await readFile(store.file, "utf8")).toBe(original);
	await writeFile(store.file, "[]");
	await expect(store.change(tasks => { tasks.length = 0; })).rejects.toThrow("已被修改");
	expect(store.tasks).toHaveLength(3); expect(await readFile(store.file, "utf8")).toBe("[]");
});
it("无效或重复任务记录导致启动失败，不悄悄覆盖记录", async () => {
	const store = new BridgeStore(temp.path);
	for (const value of ["{broken", JSON.stringify([{ ...task(), state: "running" }]), JSON.stringify([task(), task()])]) {
		await writeFile(store.file, value); await expect(store.load()).rejects.toThrow(); expect(await readFile(store.file, "utf8")).toBe(value);
	}
});
it("事件关闭和取消释放等待，重新启动使用独立 epoch", async () => {
	const events = new BridgeEvents(), controller = new AbortController();
	const pending = events.poll(0, 25, controller.signal); controller.abort();
	await expect(pending).rejects.toThrow();
	events.changed("task"); expect(await events.poll(0, 0, new AbortController().signal)).toMatchObject({ seq: 1, tasks: ["task"] });
	const waiting = events.poll(1, 25, new AbortController().signal); events.close(); await expect(waiting).rejects.toThrow("桥接已关闭");
	expect(new BridgeEvents().epoch).not.toBe(events.epoch);
});
it("令牌与任务控制文件受原生文件工具保护", async () => {
	const directory = path.join(pimoonHome, "bridge"); await mkdir(directory, { recursive: true });
	const token = path.join(directory, "token.json"); await writeFile(token, "fixture");
	await expect(checkReadablePath(temp.path, token, protectedCredentialPaths)).rejects.toThrow("受保护");
	await expect(checkWritablePath(temp.path, path.join(directory, "tasks.json"), protectedCredentialPaths)).rejects.toThrow("受保护");
});

it("退出进程留下的宿主锁可清理，活跃进程的锁不能抢占", async () => {
	const file = path.join(temp.path, "host.lock");
	await promisify(execFile)(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify({pid:process.pid}))`], { windowsHide: true });
	const unlock = await lockBridge(temp.path);
	try {
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ pid: process.pid });
		await expect(lockBridge(temp.path)).rejects.toThrow("已有桥接宿主");
	} finally { await unlock(); }
	await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});
