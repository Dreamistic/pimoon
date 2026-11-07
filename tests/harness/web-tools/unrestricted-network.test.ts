import dns from "node:dns/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as undici from "undici";
import * as configModule from "../../../src/harness/web-tools/config.ts";
import { createWebToolsRuntime } from "../../../src/harness/web-tools/web-tools-runtime.ts";
import { createNetworkDispatcher, networkConfigSignature } from "../../../src/harness/web-tools/network/dispatcher.ts";
import { validateRequestUrl } from "../../../src/harness/web-tools/network/network-policy.ts";
import { buildApprovalRequest } from "../../../src/harness/approval/pi/request.ts";
import { formatApprovalPrompt } from "../../../src/harness/approval/presentation.ts";
import { defaultWebToolsConfig } from "./config-fixture.ts";

let config: ReturnType<typeof defaultWebToolsConfig>;
const servers: Server[] = [];
const runtimes: ReturnType<typeof createWebToolsRuntime>[] = [];
const context = { toolCallId: "unrestricted" };
beforeEach(() => {
	config = defaultWebToolsConfig();
	config.webfetch.cookies.enabled = false;
	for (const provider of [...config.websearch.primary_providers, ...config.websearch.auxiliary_providers]) config.websearch[provider].enabled = false;
	vi.spyOn(configModule, "loadWebToolsConfig").mockImplementation(async () => structuredClone(config));
});
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
	await Promise.all(servers.splice(0).map(server => {
		server.closeAllConnections();
		return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}));
	vi.restoreAllMocks();
});
async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("缺少监听端口");
	return `http://127.0.0.1:${address.port}`;
}
function runtime() {
	const value = createWebToolsRuntime();
	runtimes.push(value);
	return value;
}

it.each(["localhost", "127.0.0.1", "10.0.0.1", "198.18.0.1", "169.254.169.254", "100.100.100.200", "[::1]", "[fc00::1]"])("默认允许地址 %s，不发真实特殊地址请求", async host => {
	const url = `http://${host}:8080/page`;
	expect(validateRequestUrl(url, undefined, config.network.restrict_private_addresses)).toMatchObject({ displayUrl: url });
	for (const toolName of ["http", "webfetch"]) {
		await expect(buildApprovalRequest({ type: "tool_call", toolName, toolCallId: toolName, input: { url } }, process.cwd())).resolves.toBeUndefined();
	}
});

it("网络免审批不提前解析 DNS，下载仍审批文件且不签发网络授权", async () => {
	const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("本地 DNS 不可用"));
	const input = { url: "https://proxy-only.invalid/file", mode: "download", path: "file.bin" };
	const request = await buildApprovalRequest({ type: "tool_call", toolName: "http", toolCallId: "download", input }, path.resolve("workspace"));
	expect(request?.units.map(unit => unit.action)).toEqual(["write_file"]);
	expect(request?.detail).not.toHaveProperty("addresses");
	if (request === undefined) throw new Error("缺少下载审批");
	expect(formatApprovalPrompt(request, { kind: "ask", reason: "download", items: request.units.map(unit => ({ unit, reason: "download" })) })).toContain("file.bin");
	expect(lookup).not.toHaveBeenCalled();
});

it("真实运行时无需 grant 读取本机、跨 origin 重定向及主图；恢复保护后不复用快照", async () => {
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
	const target = await listen(createServer((request, response) => {
		if (request.url === "/image") response.writeHead(200, { "content-type": "image/png" }).end(png);
		else response.writeHead(200, { "content-type": "text/html" }).end(`<main><h1>Local network article</h1><p>${"Local content. ".repeat(80)}</p><img src="/image" alt="Local article illustration"></main>`);
	}));
	const source = await listen(createServer((_request, response) => response.writeHead(302, { location: `${target}/article` }).end()));
	config.webfetch.media.mode = "on";
	const rt = runtime();
	await expect(rt.http({ url: source }, context, process.cwd())).resolves.toMatchObject({ status: 200, url: `${target}/article`, body: expect.stringContaining("Local content") });
	const page = await rt.fetch({ url: source }, { ...context, acceptsImages: true });
	expect(page.details).toMatchObject({ status: "success", redirect_count: 1 });
	expect(page.media).toHaveLength(1);
	await expect(rt.fetch({ url: source, offset: 0 }, context)).resolves.toMatchObject({ details: { status: "success", snapshot: "hit" } });
	const before = networkConfigSignature(config.network);
	config.network.restrict_private_addresses = true;
	expect(networkConfigSignature(config.network)).not.toBe(before);
	await expect(rt.fetch({ url: source, offset: 0 }, context)).resolves.toMatchObject({ details: { error: { code: "BLOCKED_ADDRESS" } } });
});

it("真实本地搜索端点可用，默认结果不再过滤 CSDN 和 GitCode", async () => {
	config.websearch.brave_api.enabled = true;
	config.websearch.brave_api.api_key = "fixture";
	config.websearch.brave_api.endpoint = await listen(createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ grounding: { generic: [
		{ title: "CSDN", url: "https://csdn.com/article", snippets: ["first"] },
		{ title: "GitCode", url: "https://gitcode.com/repo", snippets: ["second"] },
	] } }))));
	const result = await runtime().search({ query: "fixture", limit: 2 }, context);
	expect(result.details).toMatchObject({ status: "success", results: [{ title: "CSDN" }, { title: "GitCode" }] });
});

it("HTTP 代理接收原始域名，不再要求本地目标 DNS 解析", async () => {
	const requests: string[] = [];
	const proxy = await listen(createServer((request, response) => {
		requests.push(request.url ?? "");
		response.writeHead(200, { "content-type": "text/plain" }).end("proxied content");
	}));
	config.network.proxy = { enabled: true, http_proxy: proxy, https_proxy: proxy, socks5_proxy: "" };
	const lookup = vi.spyOn(dns, "lookup").mockRejectedValue(new Error("不应解析目标 DNS"));
	await expect(runtime().http({ url: "http://proxy-only.invalid:8080/page" }, context, process.cwd())).resolves.toMatchObject({ status: 200, body: "proxied content" });
	expect(requests).toEqual(["http://proxy-only.invalid:8080/page"]);
	expect(lookup).not.toHaveBeenCalled();
});

it("HTTPS CONNECT 保留原始域名及端口，不再固定本地解析 IP", async () => {
	const connects: string[] = [];
	const proxy = createServer();
	proxy.on("connect", (request, socket) => {
		connects.push(request.url ?? "");
		socket.on("error", () => undefined);
		socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
	});
	config.network.proxy = { enabled: true, http_proxy: "", https_proxy: await listen(proxy), socks5_proxy: "" };
	const dispatcher = createNetworkDispatcher(config.network, undici);
	try {
		await expect(undici.fetch("https://proxy-only.invalid:8443/page", { dispatcher })).rejects.toThrow();
		expect(connects).toEqual(["proxy-only.invalid:8443"]);
	} finally { await dispatcher.close(); }
});
