import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { GuiHost } from "../host.ts";
import { pimoonHome } from "../../../pimoon/profile.ts";
import { replaceConfigFile } from "../../../harness/config-file.ts";
import { BridgeTasks } from "./tasks.ts";
import { BridgeError } from "./schema.ts";
import { lockBridge, readBridgeFile } from "./files.ts";

export interface BridgeServerOptions { port?: number; directory?: string }
export type BridgeServer = Awaited<ReturnType<typeof startBridgeServer>>;
const digest = (value: string) => createHash("sha256").update(value).digest();
function requestedPort(value: number | undefined): number {
	const configured = process.env.PIMOON_BRIDGE_PORT ?? "0";
	if (value === undefined && !/^\d{1,5}$/u.test(configured)) throw new Error("PIMOON_BRIDGE_PORT 必须是 0 到 65535 的整数。");
	const port = value ?? Number(configured);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("无效桥接端口。");
	return port;
}
export async function startBridgeServer(host: GuiHost, options: BridgeServerOptions = {}) {
	const directory = options.directory ?? path.join(pimoonHome, "bridge"), port = requestedPort(options.port);
	const unlock = await lockBridge(directory);
	let bridge: BridgeTasks;
	try { bridge = new BridgeTasks(host, directory); } catch (error) { await unlock(); throw error; }
	const requests = new Set<Promise<void>>();
	const server = createServer((request, response) => {
		const pending = handle(request, response).finally(() => requests.delete(pending));
		requests.add(pending);
	});
	server.requestTimeout = 10000; server.headersTimeout = 10000;
	let actualPort = 0, expected = Buffer.alloc(32), closing = false;
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
		const controller = new AbortController(), abort = () => controller.abort();
		response.once("close", abort);
		request.on("error", abort);
		const send = (status: number, value?: unknown) => { if (!response.destroyed) response.writeHead(status).end(value === undefined ? undefined : JSON.stringify(value)); };
		try {
			if (closing) throw new BridgeError(503, "桥接正在关闭。");
			if (request.headers.origin !== undefined) throw new BridgeError(403, "桥接不接受浏览器来源请求。");
			if (![ `127.0.0.1:${actualPort}`, `[::1]:${actualPort}` ].includes(request.headers.host ?? "")) throw new BridgeError(403, "桥接 Host 必须是回环地址与当前端口。");
			const authorization = request.headers.authorization;
			if (!authorization?.startsWith("Bearer ") || !timingSafeEqual(expected, digest(authorization.slice(7)))) throw new BridgeError(401, "桥接令牌缺失或不正确。");
			const url = new URL(request.url ?? "/", "http://127.0.0.1"), pathname = decodeURIComponent(url.pathname);
			if (pathname === "/bridge/events" && request.method === "GET") {
				const after = Number(url.searchParams.get("after") ?? "0"), wait = Number(url.searchParams.get("wait") ?? "25");
				if (!Number.isSafeInteger(after) || after < 0 || !Number.isFinite(wait) || wait < 0 || wait > 25) throw new BridgeError(400, "无效事件游标或等待时间。");
				send(200, await bridge.poll(after, wait, controller.signal)); return;
			}
			if (pathname === "/bridge/tasks") {
				if (request.method === "GET") { bridge.polled(); send(200, await bridge.list()); return; }
				if (request.method === "POST") { send(201, await bridge.submit(await readJson(request))); return; }
			}
			const match = /^\/bridge\/tasks\/([^/]+)(?:\/(messages|review|cancel)|\/dialogs\/([^/]+))?$/u.exec(pathname);
			const id = match?.[1];
			if (id) {
				if (!match[2] && !match[3] && request.method === "GET") { bridge.polled(); send(200, await bridge.get(id)); return; }
				if (request.method === "POST") {
					if (match[3]) await bridge.answer(id, match[3], await readJson(request));
					else if (match[2] === "messages") await bridge.message(id, await readJson(request));
					else if (match[2] === "review") await bridge.review(id, await readJson(request));
					else if (match[2] === "cancel") await bridge.cancel(id);
					else throw new BridgeError(404, "桥接接口不存在。");
					send(204); return;
				}
			}
			throw new BridgeError(404, "桥接接口不存在。");
		} catch (error) {
			const status = error instanceof BridgeError ? error.status : error instanceof SyntaxError || error instanceof URIError ? 400 : 500;
			send(status, { error: error instanceof Error ? error.message : String(error), ...(error instanceof BridgeError && error.taskId ? { id: error.taskId } : {}) });
		} finally { response.off("close", abort); }
	}
	try {
		await bridge.load();
		const file = path.join(directory, "token.json"), original = await readBridgeFile(file, 4096);
		let token: string;
		if (original) {
			const value: unknown = JSON.parse(original);
			if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string" || !/^[a-f0-9]{64}$/u.test(value.token)) throw new Error("无效桥接令牌文件。");
			token = value.token;
		} else token = randomBytes(32).toString("hex");
		expected = digest(token);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
		});
		const address = server.address(); if (!address || typeof address === "string") throw new Error("无法读取桥接监听地址。");
		actualPort = address.port;
		await replaceConfigFile(file, original, JSON.stringify({ token, port: actualPort }) + "\n");
	} catch (error) {
		bridge.stop(); server.closeAllConnections(); server.close();
		try { await bridge.close(); } finally { await unlock(); }
		throw error;
	}
	let shutdown: Promise<void> | undefined;
	return {
		bridge, port: actualPort,
		close(): Promise<void> {
			return shutdown ??= (async () => {
				closing = true; bridge.stop(); server.closeAllConnections();
				try {
					await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
					await Promise.allSettled([...requests]);
					await bridge.close();
				} finally { await unlock(); }
			})();
		},
	};
}
function readJson(request: IncomingMessage): Promise<unknown> {
	if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) throw new BridgeError(415, "请求必须是 application/json。");
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []; let size = 0;
		const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", error); request.off("aborted", aborted); };
		const error = (value: unknown) => { cleanup(); reject(value); };
		const aborted = () => error(new BridgeError(400, "请求已中断。"));
		const data = (chunk: Buffer) => {
			size += chunk.length;
			if (size > 1024 * 1024) { error(new BridgeError(413, "桥接请求超过 1 MiB。")); request.resume(); return; }
			chunks.push(chunk);
		};
		const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (value) { reject(value); } };
		request.on("data", data); request.once("end", end); request.once("error", error); request.once("aborted", aborted);
	});
}
