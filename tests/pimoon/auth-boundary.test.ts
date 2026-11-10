import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installModelBoundary } from "../../src/pimoon/network.ts";
import { flushTelemetry, record, requestBindings, telemetryDirectory } from "../../src/pimoon/telemetry.ts";

const origin = "https://auth.openai.com";
const tokenURL = `${origin}/oauth/token`;
const userCodeURL = `${origin}/api/accounts/deviceauth/usercode`;
const deviceTokenURL = `${origin}/api/accounts/deviceauth/token`;
const secret = "SYNTHETIC_OAUTH_PRIVATE_SENTINEL";
const json = (value: unknown) => new Response(JSON.stringify(value));
const oauth = openaiCodexProvider().auth.oauth;
if (!oauth) throw new Error("Codex OAuth provider is required");
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
	it("SDK 设备码登录、令牌交换与刷新通过边界，且不记录凭据", async () => {
		transport.mockImplementation(async (input) => {
			if (String(input) === userCodeURL) return json({ device_auth_id: "synthetic-device", user_code: secret, interval: 1 });
			if (String(input) === deviceTokenURL) return json({ authorization_code: secret, code_verifier: secret });
			if (String(input) === tokenURL) return json({ access_token: access, refresh_token: secret, expires_in: 3600 });
			throw new Error("Unexpected test endpoint");
		});
		const signal = new AbortController().signal;
		const notify = vi.fn();
		const credential = await oauth.login({ signal, prompt: async () => "device_code", notify });
		expect(credential).toMatchObject({ type: "oauth", access, refresh: secret, accountId: "synthetic-account" });
		expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: "device_code", userCode: secret }));
		expect(await oauth.refresh(credential, signal)).toMatchObject({ access, refresh: secret });
		expect(transport.mock.calls.map(([url]) => url)).toEqual([userCodeURL, deviceTokenURL, tokenURL, tokenURL]);
		for (const [, options] of transport.mock.calls) expect(options).toMatchObject({ method: "POST", redirect: "error", signal });
		expect(String(transport.mock.calls[2]?.[1]?.body)).toContain("grant_type=authorization_code");
		expect(String(transport.mock.calls[3]?.[1]?.body)).toContain("grant_type=refresh_token");
		expect(requestBindings.size).toBe(0);
		record("auth_device_boundary_test");
		await flushTelemetry();
		const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
		const text = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("");
		expect(text).not.toContain(secret);
		expect(text).not.toContain(access);
	});

	it("浏览器授权的表单正文、请求头和取消信号保持原样，并禁止重定向", async () => {
		const body = new URLSearchParams({ grant_type: "authorization_code", code: secret, code_verifier: secret });
		const headers = { "Content-Type": "application/x-www-form-urlencoded" };
		const signal = new AbortController().signal;
		const response = new Response("invalid_grant", { status: 400 });
		transport.mockResolvedValue(response);
		expect(await fetch(tokenURL, { method: "POST", body, headers, signal, redirect: "follow" })).toBe(response);
		expect(transport.mock.calls[0]?.[1]).toEqual({ method: "POST", body, headers, signal, redirect: "error" });
		expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
	});


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

	it("设备码令牌接口拒绝 DELETE", async () => {
		await expect(fetch(deviceTokenURL, { method: "DELETE" })).rejects.toThrow("订阅端点");
		expect(transport).not.toHaveBeenCalled();
	});

	it.each(authPaths.map(pathname => `${origin}${pathname}`))("认证路径不放行 GET：%s", async url => {
		await expect(fetch(url)).rejects.toThrow("订阅端点");
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		"http://auth.openai.com/oauth/token", "https://auth.openai.com:444/oauth/token",
		"https://auth.openai.com.example.com/oauth/token", "https://example.com/oauth/token",
		"https://user:password@auth.openai.com/oauth/token", `${tokenURL}/extra`, `${tokenURL}?target=other`, `${tokenURL}#other`,
		`${origin}/api/accounts/oauth/token`, `${origin}/oauth/authorize`, `${origin}/api/accounts/other`, "https://api.openai.com/v1/responses",
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
