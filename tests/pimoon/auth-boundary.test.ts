import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installModelBoundary } from "../../src/pimoon/network.ts";
import { flushTelemetry, record, requestBindings, telemetryDirectory } from "../../src/pimoon/telemetry.ts";

const origin = "https://auth.openai.com";
const tokenURL = `${origin}/oauth/token`;
const authPaths = ["/oauth/token", "/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token"];
const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const original = globalThis.fetch;
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
	transport.mockReset();
	transport.mockImplementation(async () => new Response(JSON.stringify({ access_token: access, refresh_token: "AUTH_REFRESH_PRIVATE_SENTINEL", expires_in: 3600 })));
	requestBindings.clear();
	globalThis.fetch = transport;
	installModelBoundary();
});
afterEach(() => { globalThis.fetch = original; });

describe("桌面 Codex 认证网络边界", () => {
	it("真实 SDK 可自动刷新令牌，无需模型会话绑定且不记录凭据", async () => {
		const oauth = openaiCodexProvider().auth.oauth;
		if (!oauth) throw new Error("Codex OAuth unavailable");
		const signal = new AbortController().signal;
		const before = Date.now();
		const result = await oauth.refresh({ type: "oauth", access: "expired", refresh: "AUTH_OLD_PRIVATE_SENTINEL", expires: 0 }, signal);
		expect(result).toMatchObject({ access, refresh: "AUTH_REFRESH_PRIVATE_SENTINEL", accountId: "synthetic-account" });
		expect(result.expires).toBeGreaterThanOrEqual(before + 3600_000);
		expect(transport).toHaveBeenCalledExactlyOnceWith(tokenURL, expect.objectContaining({ method: "POST", redirect: "error", signal }));
		const options = transport.mock.calls[0]?.[1];
		expect(options?.body).toBeInstanceOf(URLSearchParams);
		const form = new URLSearchParams(String(options?.body));
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("AUTH_OLD_PRIVATE_SENTINEL");
		expect(requestBindings.size).toBe(0);
		record("auth_boundary_test");
		await flushTelemetry();
		const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
		const text = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("");
		for (const secret of [access, "AUTH_OLD_PRIVATE_SENTINEL", "AUTH_REFRESH_PRIVATE_SENTINEL"]) expect(text).not.toContain(secret);
	});

	it.each(authPaths)("仅放行精确认证路径的 POST：%s", async pathname => {
		await fetch(`${origin}${pathname}`, { method: "POST", body: "synthetic", redirect: "follow" });
		expect(transport).toHaveBeenCalledExactlyOnceWith(`${origin}${pathname}`, expect.objectContaining({ method: "POST", body: "synthetic", redirect: "error" }));
	});

	it("支持 URL、Request 和显式方法覆盖，保留取消信号", async () => {
		const signal = new AbortController().signal;
		await fetch(new URL(tokenURL), { method: "post", signal });
		await fetch(new Request(tokenURL, { method: "POST", body: "synthetic" }));
		await fetch(new Request(tokenURL), { method: "POST" });
		expect(transport).toHaveBeenCalledTimes(3);
		expect(transport.mock.calls[0]?.[1]?.signal).toBe(signal);
		expect(transport.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
		await expect(fetch(new Request(tokenURL, { method: "POST" }), { method: "GET" })).rejects.toThrow("订阅端点");
		expect(transport).toHaveBeenCalledTimes(3);
	});

	it.each(authPaths.map(pathname => `${origin}${pathname}`))("认证路径不放行 GET：%s", async url => {
		await expect(fetch(url)).rejects.toThrow("订阅端点");
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		"http://auth.openai.com/oauth/token", "https://auth.openai.com:444/oauth/token",
		"https://auth.openai.com.example.com/oauth/token", "https://example.com/oauth/token",
		"https://user:password@auth.openai.com/oauth/token", `${tokenURL}/extra`, `${tokenURL}?target=other`, `${tokenURL}#other`,
		`${origin}/oauth/authorize`, `${origin}/api/accounts/other`, "https://api.openai.com/v1/responses",
	])("不扩大其他端点的权限：%s", async url => {
		await expect(fetch(url, { method: "POST" })).rejects.toThrow("订阅端点");
		expect(transport).not.toHaveBeenCalled();
	});

	it("认证失败透传 SDK 错误，模型请求仍须绑定", async () => {
		transport.mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 401 }));
		const oauth = openaiCodexProvider().auth.oauth;
		if (!oauth) throw new Error("Codex OAuth unavailable");
		await expect(oauth.refresh({ type: "oauth", access: "expired", refresh: "synthetic", expires: 0 }, new AbortController().signal)).rejects.toThrow("token refresh failed (401)");
		await expect(fetch("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-6-astra" }),
		})).rejects.toThrow("未绑定");
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
