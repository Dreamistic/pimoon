import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import * as undici from "undici/index.js";
import { expect, it } from "vitest";
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
	const config = structuredClone(await loadWebToolsConfig()); config.network.proxy.enabled = false;
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
	} finally { await f.close(); }
});
