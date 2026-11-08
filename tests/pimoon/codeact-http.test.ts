import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import * as undici from "undici/index.js";
import { expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { executeHttp } from "../../src/harness/web-tools/fetch/http-function.ts";
import { loadWebToolsConfig } from "../../src/harness/web-tools/config.ts";
import { createNetworkDispatcher } from "../../src/harness/web-tools/network/dispatcher.ts";
import { createPrivateNetworkGrantFor } from "../../src/harness/web-tools/network/private-network-grant.ts";
import type { WebCapabilityOptions } from "../../src/harness/web-tools/core/runtime-types.ts";

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
	const base = path.resolve(".tmp/tests/codeact-http"); await fs.mkdir(base, { recursive: true });
	const cwd = await fs.mkdtemp(path.join(base, "case-"));
	const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture address");
	const url = `http://127.0.0.1:${address.port}`;
	const grant = createPrivateNetworkGrantFor(url, [{ address: "127.0.0.1", family: 4 }]);
	const config = structuredClone(await loadWebToolsConfig()); config.network.proxy.enabled = false; config.network.restrict_private_addresses = true;
	const dispatchers: undici.Dispatcher[] = [];
	const options: WebCapabilityOptions = {
		loadConfig: async () => config, now: () => Date.now(), fetchImpl: (url, init) => undici.fetch(url, init),
		async getDispatcher(network, pinned) {
			const dispatcher = createNetworkDispatcher(network, undici, { ...(pinned ? { pinnedAddressSet: pinned } : {}) });
			dispatchers.push(dispatcher); return dispatcher;
		},
	};
	return { cwd, url, config, options, server, context: { toolCallId: "http-fixture", privateNetworkGrant: grant },
		async close() { for (const dispatcher of dispatchers) await dispatcher.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
it("原始 GET、测速和二进制下载不调用 curl，返回真实且有界的结果", async () => {
	const data = Buffer.from([0, 1, 2, 255]);
	const f = await fixture((req, res) => {
		res.setHeader("Content-Type", req.url === "/binary" ? "application/octet-stream" : "application/json");
		res.end(req.url === "/binary" ? data : '{"value":42}');
	});
	try {
		const text = await executeHttp({ url: f.url }, f.context, f.cwd, f.options);
		expect(text).toMatchObject({ status: 200, body: '{"value":42}', bytes: 12 });
		expect(text.headers_ms).toBeGreaterThanOrEqual(0); expect(text.total_ms).toBeGreaterThanOrEqual(text.headers_ms);
		const probe = await executeHttp({ url: f.url + "/binary", mode: "probe" }, f.context, f.cwd, f.options);
		expect(probe).toMatchObject({ status: 200, bytes: 4 }); expect(probe.body).toBeUndefined(); expect(probe).not.toHaveProperty("tls_ms");
		const download = await executeHttp({ url: f.url + "/binary", mode: "download", path: "image.bin" }, f.context, f.cwd, f.options);
		expect(await fs.readFile(download.path ?? "")).toEqual(data);
		const outside = path.join(await fs.mkdtemp(path.join(path.dirname(f.cwd), "outside-")), "download.bin");
		await executeHttp({ url: f.url + "/binary", mode: "download", path: outside }, f.context, f.cwd, f.options);
		expect(await fs.readFile(outside)).toEqual(data);
		await expect(executeHttp({ url: f.url, mode: "download", path: outside }, f.context, f.cwd, f.options)).rejects.toThrow();
		expect(await fs.readFile(outside)).toEqual(data);
	} finally { await f.close(); }
});
it("未授权内网与跨 origin 内网跳转被阻止，大小限制和超时继续有效", async () => {
	const f = await fixture((req, res) => {
		if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); }
		else if (req.url === "/slow") { /* 等待客户端超时，测试退出统一关闭连接。 */ }
		else { res.setHeader("Content-Type", "text/plain"); res.end("x".repeat(1024)); }
	});
	try {
		await expect(executeHttp({ url: f.url }, { toolCallId: "unapproved" }, f.cwd, f.options)).rejects.toThrow("not allowed");
		await expect(executeHttp({ url: f.url + "/redirect" }, f.context, f.cwd, f.options)).rejects.toThrow("BLOCKED_ADDRESS");
		f.config.webfetch.media.response_bytes = 32;
		f.config.webfetch.limits.response_bytes = 32;
		await expect(executeHttp({ url: f.url }, f.context, f.cwd, f.options)).rejects.toThrow("RESPONSE_TOO_LARGE");
		await expect(executeHttp({ url: f.url + "/slow", timeout: 0.1 }, f.context, f.cwd, f.options)).rejects.toThrow("TIMEOUT");
		const controller = new AbortController();
		const pending = executeHttp({ url: f.url + "/slow" }, { ...f.context, signal: controller.signal }, f.cwd, f.options);
		controller.abort(); await expect(pending).rejects.toThrow("ABORTED");
	} finally { await f.close(); }
});
it("HTTP 复用配置代理，不需要模型传 --proxy", async () => {
	let requests = 0;
	const f = await fixture((_req, res) => { requests++; res.setHeader("Content-Type", "text/plain"); res.end("proxy fixture"); });
	try {
		f.server.on("connect", (_request, socket) => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			socket.once("data", () => { requests++; socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 13\r\nConnection: close\r\n\r\nproxy fixture"); });
		});
		f.config.network.proxy = { enabled: true, http_proxy: f.url, https_proxy: "", socks5_proxy: "" };
		const result = await executeHttp({ url: "http://93.184.216.34/probe" }, { toolCallId: "proxy-fixture" }, f.cwd, f.options);
		expect(result.body).toBe("proxy fixture"); expect(requests).toBe(1);
		await executeHttp({ url: "http://93.184.216.34/installer", mode: "download", path: "proxied.bin" }, { toolCallId: "proxy-download" }, f.cwd, f.options);
		expect(await fs.readFile(path.join(f.cwd, "proxied.bin"), "utf8")).toBe("proxy fixture");expect(requests).toBe(2);
	} finally { await f.close(); }
});


async function waitForPartial(cwd: string) {
 await vi.waitFor(async () => {
  const files = (await fs.readdir(cwd)).filter(file => file.endsWith(".tmp"));
  expect(files).toHaveLength(1);
  expect((await fs.stat(path.join(cwd, files[0] ?? "missing"))).size).toBeGreaterThan(0);
 });
}

it("24 MiB 文件在响应结束前已写盘，下载与测速不借用图片或文本额度", async () => {
 const size = 24 * 1024 * 1024, first = Buffer.alloc(128 * 1024, 7);
 let release = () => {};
 const gate = new Promise<void>(resolve => { release = resolve; });
 const f = await fixture((_req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");res.setHeader("Content-Length", size);
  res.write(first);void gate.then(() => res.end(Buffer.alloc(size - first.length, 7)));
 });
 try {
  f.config.webfetch.media.response_bytes = 1;f.config.webfetch.limits.response_bytes = 1;
  const pending = executeHttp({ url: f.url, mode: "download", path: "installer.bin" }, f.context, f.cwd, f.options);
  await waitForPartial(f.cwd);
  await expect(fs.access(path.join(f.cwd, "installer.bin"))).rejects.toThrow();
  release();const result = await pending;
  expect(result).toMatchObject({ bytes: size, status: 200 });expect(result.body).toBeUndefined();
  const actual = await fs.readFile(path.join(f.cwd, "installer.bin"));
  expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(Buffer.alloc(size, 7)).digest("hex"));
  expect(await fs.readdir(f.cwd)).toEqual(["installer.bin"]);
  const probe = await executeHttp({ url: f.url, mode: "probe" }, f.context, f.cwd, f.options);
  expect(probe).toMatchObject({ bytes: size });expect(probe.body).toBeUndefined();
 } finally { release();await f.close(); }
});

it.each(["length", "chunked", "gzip"])("下载超限反馈正确配置键并清理半成品：%s", async encoding => {
 const plain = Buffer.alloc(2048, 65);
 const f = await fixture((_req, res) => {
  res.setHeader("Content-Type", "application/octet-stream");
  if (encoding === "length") { res.setHeader("Content-Length", plain.length);res.end(plain); }
  else if (encoding === "gzip") { const data = gzipSync(plain);res.setHeader("Content-Encoding", "gzip");res.setHeader("Content-Length", data.length);res.end(data); }
  else { res.write(plain.subarray(0, 512));res.end(plain.subarray(512)); }
 });
 try {
  f.config.webfetch.download.response_bytes = 1024;
  await expect(executeHttp({ url: f.url, mode: "download", path: "oversized.bin" }, f.context, f.cwd, f.options)).rejects.toThrow("limit_config=webfetch.download.response_bytes; max_bytes=1024");
  expect(await fs.readdir(f.cwd)).toEqual([]);
  await expect(executeHttp({ url: f.url, mode: "probe" }, f.context, f.cwd, f.options)).rejects.toThrow("RESPONSE_TOO_LARGE");
 } finally { await f.close(); }
});

it.each(["cancel", "timeout", "disconnect"])("已开始写盘的下载失败后不留下目标或临时文件：%s", async outcome => {
 let response: ServerResponse | undefined;
 const f = await fixture((_req, res) => { response = res;res.setHeader("Content-Type", "application/octet-stream");res.write(Buffer.alloc(16384)); });
 const controller = new AbortController();
 try {
  const pending = executeHttp({ url: f.url, mode: "download", path: "partial.bin", timeout: outcome === "timeout" ? 0.4 : 10 }, { ...f.context, signal: controller.signal }, f.cwd, f.options);
  const failure = expect(pending).rejects.toThrow(outcome === "cancel" ? "ABORTED" : outcome === "timeout" ? "TIMEOUT" : "CONNECTION_FAILED");
  await waitForPartial(f.cwd);
  if (outcome === "cancel") controller.abort();
  if (outcome === "disconnect") response?.destroy();
  await failure;expect(await fs.readdir(f.cwd)).toEqual([]);
 } finally { controller.abort();await f.close(); }
});

it("HTTP 错误不落盘、不自动重试，已有目标在发请求前拒绝", async () => {
 let requests = 0;
 const f = await fixture((_req, res) => { requests++;res.writeHead(503, { "Content-Type": "text/plain" });res.end("unavailable"); });
 try {
  await expect(executeHttp({ url: f.url, mode: "download", path: "failed.bin" }, f.context, f.cwd, f.options)).rejects.toThrow("HTTP_ERROR: 503");
  expect(requests).toBe(1);expect(await fs.readdir(f.cwd)).toEqual([]);
  await fs.writeFile(path.join(f.cwd, "keep.bin"), "original");
  await expect(executeHttp({ url: f.url, mode: "download", path: "keep.bin" }, f.context, f.cwd, f.options)).rejects.toThrow("destination exists");
  expect(requests).toBe(1);expect(await fs.readFile(path.join(f.cwd, "keep.bin"), "utf8")).toBe("original");
 } finally { await f.close(); }
});

it("同目标并发只提交一次，重定向仍可下载", async () => {
 let requests = 0;
 const f = await fixture((req, res) => {
  requests++;
  if (req.url === "/redirect") { res.writeHead(302, { location: "/binary" });res.end(); }
  else { res.setHeader("Content-Type", "application/octet-stream");res.end("payload"); }
 });
 try {
  const results = await Promise.allSettled([0, 1].map(() => executeHttp({ url: f.url + "/redirect", mode: "download", path: "once.bin" }, f.context, f.cwd, f.options)));
  expect(results.map(row => row.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(requests).toBe(2);expect(await fs.readdir(f.cwd)).toEqual(["once.bin"]);
  expect(await fs.readFile(path.join(f.cwd, "once.bin"), "utf8")).toBe("payload");
 } finally { await f.close(); }
});
