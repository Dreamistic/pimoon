import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GuiHost } from "../../../src/gui/host/host.ts";
import type { GuiClient } from "../../../src/gui/host/client.ts";
import type { BridgeTaskView } from "../../../src/gui/host/bridge/schema.ts";
import { assistant } from "../helpers/transcript-fixtures.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
	return (await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, windowsHide: true })).stdout.trim();
}
async function repository(cwd: string) { await git(cwd, "init"); await git(cwd, "add", "input.txt"); await git(cwd, "commit", "-m", "fixture"); }
async function openBridge(host: GuiHost, agentDir: string) {
	const directory = path.join(agentDir, "bridge");
	await host.startBridge({ directory, port: 0 });
	const token = JSON.parse(await readFile(path.join(directory, "token.json"), "utf8")) as { token: string; port: number };
	const bridge = host.bridge; if (!bridge) throw new Error("missing bridge");
	const request = (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
		const value = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
		const request = httpRequest({ hostname: "127.0.0.1", port: token.port, path: route, method,
			headers: { Authorization: `Bearer ${token.token}`, ...(value === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, response => {
			let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += String(chunk); });
			response.on("end", () => { try { resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }); } catch (error) { reject(error); } });
		});
		request.on("error", reject); request.end(value);
	});
	const submit = async (cwd: string) => {
		const result = await request("POST", "/bridge/tasks", { cwd, goal: "检查 input.txt 并写入 output.txt", acceptance: ["文件写入正确"], constraints: ["仅隔离工作区"], title: "fixture" });
		expect(result.status, JSON.stringify(result.body)).toBe(201);
		if (!result.body || typeof result.body !== "object" || !("id" in result.body) || typeof result.body.id !== "string") throw new Error("missing task ID");
		return result.body.id;
	};
	const get = async (id: string): Promise<BridgeTaskView> => {
		const result = await request("GET", `/bridge/tasks/${id}`); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body as BridgeTaskView;
	};
	const wait = (id: string, state: BridgeTaskView["state"]) => expect.poll(async () => (await get(id)).state, { timeout: 10000 }).toBe(state);
	return { request, submit, get, wait, token, bridge, directory };
}
const delivery = { summary: "已完成", changes: ["output.txt"], verification: ["读取文件核验"], unverified: [], objections: [] };

export function bridgeTests(fixture: () => { host: GuiClient; cwd: string; agentDir: string }) {
	describe("委派桥接 HTTP", () => {
		it("委派 CodeAct 澄清不授予审批，交付、打回、重开后再次交付走同一会话", async () => {
			const { host, cwd, agentDir } = fixture(); await repository(cwd);
			await writeFile(path.join(agentDir, "configs/approval-ai.jsonc"), '{"model":"gui-fixture/test","routine":false}');
			const ordinary = host.runtime.session.getAllTools().map(tool => tool.name);
			expect(ordinary).not.toContain("ask"); expect(ordinary).not.toContain("deliver");
			const api = await openBridge(host.host, agentDir);
			const submitted = await api.bridge.submit({ cwd, goal: "bridge-tools-flow", acceptance: [], constraints: [] });
			const id = submitted.id;
			const answerRound = async () => {
				await expect.poll(async () => (await api.get(id)).dialogs[0]?.kind, { timeout: 10000 }).toBe("select");
				let dialog = (await api.get(id)).dialogs[0]; if (!dialog) throw new Error("missing ask");
				expect(dialog.title).toBe("是否继续？");
				expect((await api.request("POST", `/bridge/tasks/${id}/dialogs/${dialog.id}`, { value: "允许" })).status).toBe(204);
				await expect.poll(async () => (await api.get(id)).dialogs[0]?.kind, { timeout: 10000 }).toBe("approval");
				dialog = (await api.get(id)).dialogs[0]; if (!dialog) throw new Error("missing approval");
				expect((await api.request("POST", `/bridge/tasks/${id}/dialogs/${dialog.id}`, { value: "Allow once" })).status).toBe(204);
				await api.wait(id, "delivered");
			};
			await answerRound();
			expect((await api.get(id)).delivery).toMatchObject({ summary: "done", head: await git(cwd, "rev-parse", "HEAD") });
			const session = host.host.sessions.get(id); if (!session?.execution) throw new Error("missing session");
			expect(getCurrentSystemPrompt(session.execution.runtime.session.messages)).toContain("Delegated task: clarify ambiguity with ask");
			expect(getCurrentSystemPrompt(host.runtime.session.messages)).not.toContain("Delegated task:");
			await expect.poll(() => session.canRelease).toBe(true); await session.release();
			expect(session.execution).toBeUndefined();
			expect((await api.request("POST", `/bridge/tasks/${id}/review`, { verdict: "rejected", feedback: "bridge-tools-flow: 再检查" })).status).toBe(204);
			await answerRound();
			expect((await api.get(id)).history).toHaveLength(1);
			expect((await api.request("POST", `/bridge/tasks/${id}/review`, { verdict: "accepted" })).status).toBe(204);
			expect((await api.get(id)).state).toBe("accepted");
			expect(host.runtime.session.getAllTools().map(tool => tool.name)).toEqual(ordinary);
		});
		it("认证、Origin、Host、请求类型和大小均在派单前校验", async () => {
			const { host, cwd, agentDir } = fixture(), api = await openBridge(host.host, agentDir);
			expect(api.token.token).toMatch(/^[a-f0-9]{64}$/u);
			for (const authorization of ["", "Bearer wrong", `Bearer ${"0".repeat(64)}`])
				expect((await api.request("GET", "/bridge/tasks", undefined, { Authorization: authorization })).status).toBe(401);
			for (const origin of ["", "null", `http://127.0.0.1:${api.token.port}`])
				expect((await api.request("GET", "/bridge/tasks", undefined, { Origin: origin })).status).toBe(403);
			for (const host of [`evil.invalid:${api.token.port}`, "127.0.0.1:1", `localhost:${api.token.port}`])
				expect((await api.request("GET", "/bridge/tasks", undefined, { Host: host })).status).toBe(403);
			expect((await api.request("GET", "/bridge/tasks")).body).toEqual([]);
			expect((await api.request("POST", "/bridge/tasks", "{}", { "Content-Type": "text/plain" })).status).toBe(415);
			expect((await api.request("POST", "/bridge/tasks", "{")).status).toBe(400);
			expect((await api.request("POST", "/bridge/tasks", "x".repeat(1024 * 1024 + 1))).status).toBe(413);
			expect((await api.request("POST", "/bridge/tasks", { cwd, goal: "task", acceptance: [], constraints: [], actor: "owner" })).status).toBe(400);
			expect((await api.request("GET", "/bridge/tasks/missing")).status).toBe(404);
			expect((await api.request("GET", "/bridge/events?after=-1")).status).toBe(400);
			expect((await api.request("GET", "/bridge/events?wait=26")).status).toBe(400);
			const other = new GuiHost();
			try { await expect(other.startBridge({ directory: api.directory, port: 0 })).rejects.toThrow("已有桥接宿主"); }
			finally { await other.dispose(); }
			expect((await api.request("GET", "/bridge/tasks")).status).toBe(200);
		});
		it("派单一秒内返回并继续等待审批，真实 Git 根阻止子目录重复派单", async () => {
			const { host, cwd, agentDir } = fixture(); await repository(cwd);
			await mkdir(path.join(cwd, "child")); await writeFile(path.join(cwd, "dirty.txt"), "dirty");
			await writeFile(path.join(agentDir, "configs/approval-ai.jsonc"), '{"model":"gui-fixture/test","routine":false}');
			const api = await openBridge(host.host, agentDir), started = performance.now(), id = await api.submit(cwd);
			expect(performance.now() - started).toBeLessThan(1000);
			expect(["running", "waiting"]).toContain((await api.get(id)).state);
			const conflict = await api.request("POST", "/bridge/tasks", { cwd: path.join(cwd, "child"), goal: "second", acceptance: [], constraints: [] });
			expect(conflict).toMatchObject({ status: 409, body: { id } });
			await api.wait(id, "waiting");
			const task = await api.get(id), dialog = task.dialogs[0]; if (!dialog) throw new Error("missing approval");
			expect(task.base).toEqual({ head: await git(cwd, "rev-parse", "HEAD"), dirty: true });
			expect(dialog.approval).toMatchObject({ tool: "write", cwd: cwd.replaceAll("\\", "/"), reason: expect.any(String), summary: expect.any(String), content: expect.any(Array) });
			expect(host.host.sessions.get(id)?.activity.title).toBe("delegate: fixture");
			expect(host.host.sessions.get(id)?.observed).toBe(false);
			expect((await api.request("POST", `/bridge/tasks/${id}/messages`, { text: "优先检查输出" })).status).toBe(204);
			const [ownerReply, delegateReply] = await Promise.all([
				host.dispatch({ action: "dialog", id: dialog.id, value: "Allow once" }, id),
				api.request("POST", `/bridge/tasks/${id}/dialogs/${dialog.id}`, { value: "Allow once" }),
			]);
			expect(ownerReply).toBeUndefined(); expect(delegateReply.status).toBe(409);
			await api.request("POST", `/bridge/tasks/${id}/cancel`);
			expect((await api.get(id)).state).toBe("cancelled");
			const stored = JSON.parse(await readFile(path.join(api.directory, "tasks.json"), "utf8"));
			expect(stored[0]).not.toHaveProperty("state");
		});
		it("并发派单只有一个成功，delegate 审批落盘且未 deliver 时是 stalled", async () => {
			const { host, cwd, agentDir } = fixture();
			await writeFile(path.join(agentDir, "configs/approval-ai.jsonc"), '{"model":"gui-fixture/test","routine":false}');
			const api = await openBridge(host.host, agentDir), input = { cwd, goal: "检查输入", acceptance: [], constraints: [] };
			const results = await Promise.all([api.request("POST", "/bridge/tasks", input), api.request("POST", "/bridge/tasks", input)]);
			expect(results.map(result => result.status).sort()).toEqual([201, 409]);
			const tasks = await api.bridge.list(), task = tasks[0]; if (!task) throw new Error("missing task");
			await api.wait(task.id, "waiting");
			const dialog = (await api.get(task.id)).dialogs[0]; if (!dialog) throw new Error("missing approval");
			expect((await api.request("POST", `/bridge/tasks/${task.id}/dialogs/${dialog.id}`, { value: "Allow once" })).status).toBe(204);
			await expect(host.dispatch({ action: "dialog", id: dialog.id, value: "Deny" }, task.id)).rejects.toThrow("已结束");
			await api.wait(task.id, "stalled");
			expect(await api.get(task.id)).toMatchObject({ delivery: null, lastAssistant: "GUI completed" });
			const execution = host.host.sessions.get(task.id)?.execution; if (!execution) throw new Error("missing execution");
			expect(execution.runtime.session.sessionManager.getEntries()).toEqual(expect.arrayContaining([
				expect.objectContaining({ customType: "approval_decision", data: expect.objectContaining({ actor: "delegate" }) }),
			]));
			execution.runtime.session.sessionManager.appendMessage(assistant([{ type: "text", text: "x".repeat(3000) }]));
			expect((await api.get(task.id)).lastAssistant).toHaveLength(2000);
		});
		it("等待中重启后为 stalled，令牌保留而 epoch 更新，原会话可续跑", async () => {
			const { host, cwd, agentDir } = fixture();
			await writeFile(path.join(agentDir, "configs/approval-ai.jsonc"), '{"model":"gui-fixture/test","routine":false}');
			const api = await openBridge(host.host, agentDir), id = await api.submit(cwd); await api.wait(id, "waiting");
			const epoch = api.bridge.events.epoch;
			await host.host.dispose();
			const restarted = new GuiHost();
			try {
				await restarted.start(cwd);
				const next = await openBridge(restarted, agentDir);
				expect(next.token.token).toBe(api.token.token); expect(next.bridge.events.epoch).not.toBe(epoch);
				expect(await next.get(id)).toMatchObject({ state: "stalled", dialogs: [] });
				expect((await next.request("GET", "/bridge/events?after=999999&wait=0")).body).toMatchObject({ tasks: [id], epoch: next.bridge.events.epoch });
				await writeFile(path.join(agentDir, "configs/approval-ai.jsonc"), '{"enabled":false}');
				expect((await next.request("POST", `/bridge/tasks/${id}/messages`, { text: "继续检查" })).status).toBe(204);
				await next.wait(id, "stalled"); expect((await next.get(id)).lastAssistant).toBe("GUI completed");
			} finally { await restarted.dispose(); }
		});
		it("启动信任对话框中取消后不再发送首条消息或执行模型工具", async () => {
			const { host, cwd, agentDir } = fixture();
			const file = path.join(agentDir, "settings.json");
			await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), defaultProjectTrust: "ask" }));
			await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
			await writeFile(path.join(cwd, ".pi", "extensions", "project.ts"), 'export default () => { throw new Error("untrusted extension executed"); };');
			const api = await openBridge(host.host, agentDir), id = await api.submit(cwd); await api.wait(id, "waiting");
			expect((await api.get(id)).dialogs[0]?.kind).toBe("select");
			await host.host.catalog.refresh();
			expect(host.host.catalog.value).toEqual(expect.arrayContaining([expect.objectContaining({ path: (await api.get(id)).sessionFile, title: "delegate: fixture" })]));
			expect((await api.request("POST", `/bridge/tasks/${id}/cancel`)).status).toBe(204);
			await expect.poll(() => host.host.sessions.get(id)?.canRelease, { timeout: 10000 }).toBe(true);
			const contents = await readFile((await api.get(id)).sessionFile, "utf8");
			expect(contents).not.toContain('"role":"user"');
			await expect(readFile(path.join(cwd, "output.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		});
		it("重启保留未裁决交付且不自动加载或运行原会话", async () => {
			const { host, cwd, agentDir } = fixture(), api = await openBridge(host.host, agentDir), id = await api.submit(cwd);
			await api.wait(id, "stalled"); await api.bridge.recordDelivery(id, delivery); await host.host.dispose();
			const restarted = new GuiHost();
			try {
				await restarted.start(cwd); const next = await openBridge(restarted, agentDir);
				expect(await next.get(id)).toMatchObject({ state: "delivered", delivery });
				expect(restarted.sessions.has(id)).toBe(false);
				expect((await next.request("POST", `/bridge/tasks/${id}/review`, { verdict: "accepted" })).status).toBe(204);
				expect(restarted.sessions.get(id)?.execution).toBeUndefined();
			} finally { await restarted.dispose(); }
		});
		it("交付打回保存历史并续跑同一会话，交付 HEAD 和验收结果持久化", async () => {
			const { host, cwd, agentDir } = fixture(); await repository(cwd);
			const api = await openBridge(host.host, agentDir), id = await api.submit(cwd); await api.wait(id, "stalled");
			await git(cwd, "add", "output.txt"); await git(cwd, "commit", "-m", "delivery");
			await api.bridge.recordDelivery(id, delivery);
			const first = await api.get(id); expect(first.state).toBe("delivered");
			expect(first.delivery?.head).toBe(await git(cwd, "rev-parse", "HEAD")); expect(first.delivery?.head).not.toBe(first.base.head);
			expect((await api.request("POST", `/bridge/tasks/${id}/review`, { verdict: "rejected" })).status).toBe(400);
			expect((await api.request("POST", `/bridge/tasks/${id}/messages`, { text: "继续" })).status).toBe(409);
			expect((await api.request("POST", `/bridge/tasks/${id}/review`, { verdict: "rejected", feedback: "补充检查" })).status).toBe(204);
			await api.wait(id, "stalled"); expect(await api.get(id)).toMatchObject({ delivery: null, history: [{ feedback: "补充检查", delivery: first.delivery }] });
			await api.bridge.recordDelivery(id, { ...delivery, summary: "补充完成" });
			expect((await api.request("POST", `/bridge/tasks/${id}/review`, { verdict: "accepted" })).status).toBe(204);
			expect((await api.get(id)).state).toBe("accepted");
			expect((await api.request("POST", `/bridge/tasks/${id}/cancel`)).status).toBe(409);
			const second = await api.submit(cwd); expect(second).not.toBe(id); await api.wait(second, "stalled");
		});
		it("长轮询返回变化 ID；外部删除变 lost，关闭时释放等待请求", async () => {
			const { host, cwd, agentDir } = fixture(), api = await openBridge(host.host, agentDir);
			const waiting = api.request("GET", "/bridge/events?after=0&wait=25");
			const id = await api.submit(cwd); expect((await waiting).body).toMatchObject({ tasks: [id] });
			await api.wait(id, "stalled");
			const before = (await api.request("GET", "/bridge/events?after=0&wait=0")).body as { seq: number };
			await unlink((await api.get(id)).sessionFile);
			expect((await api.request("GET", `/bridge/events?after=${before.seq}&wait=0.05`)).body).toMatchObject({ tasks: [id] });
			expect((await api.get(id)).state).toBe("lost");
			const controller = new AbortController();
			const cursor = await api.bridge.poll(0, 0, controller.signal);
			const pending = api.bridge.poll(cursor.seq, 25, controller.signal).catch(error => error);
			await host.host.dispose(); expect(await pending).toBeInstanceOf(Error);
		});
		it("异步执行错误留在任务上，非法命令和敏感弹窗不能绕过身份限制", async () => {
			const { host, cwd, agentDir } = fixture(), api = await openBridge(host.host, agentDir), id = await api.submit(cwd);
			await api.wait(id, "stalled");
			expect((await api.request("POST", `/bridge/tasks/${id}/messages`, { text: "/login" })).status).toBe(400);
			const execution = host.host.sessions.get(id)?.execution; if (!execution) throw new Error("missing execution");
			const question = execution.dialogs.ask("secret", "凭据", "", [], "private-value");
			const dialog = (await api.get(id)).dialogs[0]; if (!dialog) throw new Error("missing secret");
			expect(dialog.initial).toBe("");
			expect((await api.request("POST", `/bridge/tasks/${id}/dialogs/${dialog.id}`, { value: "attempt" })).status).toBe(403);
			await host.dispatch({ action: "dialog", id: dialog.id, value: null }, id); await question;
			const prompt = vi.spyOn(execution.runtime.session, "prompt").mockRejectedValueOnce(new Error("fixture async failure"));
			try {
				expect((await api.request("POST", `/bridge/tasks/${id}/messages`, { text: "继续" })).status).toBe(204);
				await expect.poll(async () => (await api.get(id)).lastError).toBe("fixture async failure");
				expect((await api.get(id)).state).toBe("stalled");
			} finally { prompt.mockRestore(); }
		});
		it("模型 HTTP 失败即使不抛出 prompt 异常，也记录错误并返回 stalled", async () => {
			const { host, cwd, agentDir } = fixture(), api = await openBridge(host.host, agentDir), id = await api.submit(cwd);
			await api.wait(id, "stalled");
			expect((await api.request("POST", `/bridge/tasks/${id}/messages`, { text: "bridge-provider-failure" })).status).toBe(204);
			await expect.poll(async () => (await api.get(id)).lastError, { timeout: 10000 }).toContain("bridge-provider-failure");
			expect(await api.get(id)).toMatchObject({ state: "stalled", lastAssistant: expect.stringContaining("bridge-provider-failure") });
		});
		it("委派轮询后六十秒内抑制桌面通知，离线后恢复且普通会话不受影响", async () => {
			const { host, cwd, agentDir } = fixture(); vi.stubEnv("PIMOON_NO_NOTIFICATIONS", undefined);
			const api = await openBridge(host.host, agentDir), id = await api.submit(cwd);
			await expect.poll(async () => (await api.bridge.get(id)).state, { timeout: 10000 }).toBe("stalled");
			const events: unknown[] = [], connection = host.connect(delivery => { if (delivery.kind === "notification") events.push(delivery.value); });
			connection.attend({ sessionId: null, focused: false, destination: "fixture" });
			const execution = host.host.sessions.get(id)?.execution; if (!execution) throw new Error("missing execution");
			const notify = () => execution.emit({ type: "notification", value: { kind: "completed", sessionId: id, firstMessage: "fixture", name: undefined } });
			const clock = vi.spyOn(Date, "now");
			try {
				notify(); expect(events).toHaveLength(1);
				await api.request("GET", "/bridge/tasks"); notify(); expect(events).toHaveLength(1);
				host.execution.emit({ type: "notification", value: { kind: "completed", sessionId: host.runtime.session.sessionId, firstMessage: "ordinary", name: undefined } });
				expect(events).toHaveLength(2);
				clock.mockReturnValue(Date.now() + 60001); notify(); expect(events).toHaveLength(3);
			} finally { clock.mockRestore(); connection.close(); }
		});
	});
}
