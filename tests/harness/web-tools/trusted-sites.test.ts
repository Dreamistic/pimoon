import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as undici from "undici";
import { defaultWebToolsConfig } from "./config-fixture.ts";
import { createNetworkDispatcher, networkConfigSignature } from "../../../src/harness/web-tools/network/dispatcher.ts";
import { inspectWebFetchTarget, resolveAllowedAddresses, validateRequestUrl } from "../../../src/harness/web-tools/network/network-policy.ts";
import { isTrustedHttpsOrigin, validateTrustedHttpsOrigins } from "../../../src/harness/web-tools/network/trusted-sites.ts";
import { classifyNetworkError } from "../../../src/harness/web-tools/network/errors.ts";

const origins = ["https://github.com", "https://raw.githubusercontent.com"];
const resolver: { lookup(hostname: string, options: { all: true }): Promise<LookupAddress[]> } = dns;
afterEach(() => vi.restoreAllMocks());

describe("精确 HTTPS 站点授权", () => {
	it("默认程序员站点使用精确 HTTPS origin，清空后不再匹配", () => {
		const config = defaultWebToolsConfig();
		expect(() => validateTrustedHttpsOrigins(config.network.trusted_https_origins)).not.toThrow();
		for (const origin of origins) expect(config.network.trusted_https_origins).toContain(origin);
		expect(isTrustedHttpsOrigin(new URL("https://github.com:443/repo"), origins)).toBe(true);
		expect(isTrustedHttpsOrigin(new URL("https://github.com/repo"), [])).toBe(false);
	});

	it.each(["http://github.com", "https://github.com:8443", "https://github.com/path", "https://github.com/",
		"https://user:pass@github.com", "https://*.github.com", "https://127.0.0.1", "https://172.19.0.9",
		"https://[::1]", "https://localhost", "https://sub.localhost", "https://github.com.", "not-a-url"])("拒绝无效名单项 %s", origin => {
		expect(() => validateTrustedHttpsOrigins([origin])).toThrow();
	});

	it.each(["http://github.com/x", "https://github.com:8443/x", "https://github.com.evil.test/x", "https://sub.github.com/x",
		"https://github.com@evil.test/x", "https://user@github.com/x", "https://172.19.0.9/x"])("不继承其他 origin 的授权：%s", url => {
		expect(isTrustedHttpsOrigin(new URL(url), origins)).toBe(false);
	});

	it("预检查标记已授权的普通私网解析，连接解析仍按主机限制", async () => {
		vi.spyOn(resolver, "lookup").mockResolvedValue([{ address: "172.19.0.9", family: 4 }]);
		await expect(inspectWebFetchTarget("https://github.com/repo", { trustedHttpsOrigins: origins })).resolves.toMatchObject({ status: "trusted" });
		await expect(inspectWebFetchTarget("https://github.com/repo")).resolves.toMatchObject({ status: "private" });
		await expect(resolveAllowedAddresses("github.com", { trustedPrivateHostname: "github.com" })).resolves.toEqual([{ address: "172.19.0.9", family: 4 }]);
		await expect(resolveAllowedAddresses("evil.test", { trustedPrivateHostname: "github.com" })).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" });
		await expect(resolveAllowedAddresses("172.19.0.9", { trustedPrivateHostname: "172.19.0.9" })).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" });
	});

	it.each(["127.0.0.1", "169.254.169.254", "0.0.0.0", "100.100.100.200", "::1", "fc00::1", "::ffff:127.0.0.1"])("即使站点获授权仍拒绝特殊地址 %s", async address => {
		vi.spyOn(resolver, "lookup").mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
		await Promise.all([
			expect(inspectWebFetchTarget("https://github.com/repo", { trustedHttpsOrigins: origins })).resolves.toMatchObject({ status: "private" }),
			expect(resolveAllowedAddresses("github.com", { trustedPrivateHostname: "github.com" })).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" }),
		]);
	});

	it("混合解析包含一个特殊地址时整体拒绝", async () => {
		vi.spyOn(resolver, "lookup").mockResolvedValue([{ address: "172.19.0.9", family: 4 }, { address: "169.254.169.254", family: 4 }]);
		await expect(resolveAllowedAddresses("github.com", { trustedPrivateHostname: "github.com" })).rejects.toMatchObject({ name: "BLOCKED_ADDRESS" });
		expect(validateRequestUrl("https://127.0.0.1/")).toMatchObject({ error: { code: "BLOCKED_ADDRESS" } });
	});

	it("撤销名单改变连接池签名，不复用已获授权的网络配置", () => {
		const first = defaultWebToolsConfig().network;
		first.trusted_https_origins = origins;
		expect(networkConfigSignature(first)).toBe(networkConfigSignature({ ...first, trusted_https_origins: [...origins].reverse() }));
		expect(networkConfigSignature(first)).not.toBe(networkConfigSignature({ ...first, trusted_https_origins: [] }));
	});

	it("真实代理只收到获授权目标的固定 IP:443，其他域名和端口发出前即拒绝", async () => {
		const connects: string[] = [];
		const proxy = createServer();
		proxy.on("connect", (request, socket) => {
			connects.push(request.url ?? "");
			socket.on("error", () => undefined);
			socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
		});
		await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
		const address = proxy.address();
		if (!address || typeof address === "string") throw new Error("Missing proxy address");
		const config = defaultWebToolsConfig().network;
		config.restrict_private_addresses = true;
		config.trusted_https_origins = origins;
		config.proxy = { enabled: true, http_proxy: "", https_proxy: `http://127.0.0.1:${address.port}`, socks5_proxy: "" };
		vi.spyOn(resolver, "lookup").mockResolvedValue([{ address: "172.19.0.9", family: 4 }]);
		const dispatcher = createNetworkDispatcher(config, undici);
		try {
			await expect(undici.fetch("https://github.com/repo", { dispatcher })).rejects.toThrow();
			expect(connects).toEqual(["172.19.0.9:443"]);
			for (const url of ["http://github.com/repo", "https://github.com:8443/repo", "https://evil.test/", "https://sub.github.com/"]) {
				const error: unknown = await undici.fetch(url, { dispatcher }).then(() => undefined, (cause: unknown) => cause);
				expect(classifyNetworkError(error)).toBe("BLOCKED_ADDRESS");
			}
			expect(connects).toEqual(["172.19.0.9:443"]);
		} finally {
			await dispatcher.close();
			await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
		}
	});
});
