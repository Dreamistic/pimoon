import { describe, expect, it } from "vitest";
import { classifyNetworkError, networkErrorMessage } from "../../../src/harness/web-tools/network/errors.ts";

describe("网络错误分类", () => {
	it.each([
		["DNS resolved to blocked address 172.19.0.9.", "EACCES", "BLOCKED_ADDRESS"],
		["DNS resolved to blocked address 10.0.0.1.", "EACCES", "BLOCKED_ADDRESS"],
		["Target address 127.0.0.1 is blocked.", "EACCES", "BLOCKED_ADDRESS"],
		["getaddrinfo ENOTFOUND missing.invalid", "ENOTFOUND", "DNS_FAILED"],
		["DNS lookup returned no addresses.", "ENOTFOUND", "DNS_FAILED"],
		["connect ECONNREFUSED", "ECONNREFUSED", "CONNECTION_FAILED"],
		["certificate has expired", "CERT_HAS_EXPIRED", "TLS_FAILED"],
		["Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT", "TIMEOUT"],
	])("%s 分类为 %s/%s", (message, code, expected) => {
		const cause = Object.assign(new Error(message), { code });
		const error = new TypeError("fetch failed", { cause });
		expect(classifyNetworkError(error)).toBe(expected);
		expect(networkErrorMessage(error)).toContain(message);
	});

	it("用户取消优先于同时发生的 DNS 拒绝", () => {
		const owner = new AbortController();
		owner.abort();
		expect(classifyNetworkError(new Error("DNS resolved to blocked address 172.19.0.9."), owner.signal)).toBe("ABORTED");
	});
});
