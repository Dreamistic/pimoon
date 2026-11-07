import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { installModelBoundary } from "../../src/pimoon/network.ts";
import { flushTelemetry, requestBindings, telemetryDirectory } from "../../src/pimoon/telemetry.ts";

const origin = "https://auth.openai.com";
const tokenURL = `${origin}/oauth/token`;
const userCodeURL = `${origin}/api/accounts/deviceauth/usercode`;
const deviceTokenURL = `${origin}/api/accounts/deviceauth/token`;
const secret = "SYNTHETIC_OAUTH_PRIVATE_SENTINEL";
const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const originalFetch = globalThis.fetch;
const transport = vi.fn<typeof fetch>(async () => new Response("{}"));
const json = (value: unknown) => new Response(JSON.stringify(value));
const oauth = openaiCodexProvider().auth.oauth;
if (!oauth) throw new Error("Codex OAuth provider is required");

beforeEach(() => {
	transport.mockReset();
	transport.mockImplementation(async () => new Response("{}"));
	requestBindings.clear();
	globalThis.fetch = transport;
	installModelBoundary();
});
afterEach(() => { globalThis.fetch = originalFetch; });

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

	it("URL、Request 及显式方法覆盖使用相同的认证边界", async () => {
		await fetch(new URL(tokenURL), { method: "post", body: "synthetic" });
		await fetch(new Request(userCodeURL, { method: "POST", body: "{}" }));
		await fetch(new Request(deviceTokenURL), { method: "POST", body: "{}" });
		expect(transport).toHaveBeenCalledTimes(3);
		expect(transport.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
		await expect(fetch(new Request(tokenURL, { method: "POST" }), { method: "GET" })).rejects.toThrow("订阅端点");
		expect(transport).toHaveBeenCalledTimes(3);
	});

	it.each([
		[tokenURL, "GET"], [userCodeURL, "GET"], [deviceTokenURL, "DELETE"],
		["http://auth.openai.com/oauth/token", "POST"],
		["https://auth.openai.com:444/oauth/token", "POST"],
		["https://auth.openai.com.example.com/oauth/token", "POST"],
		["https://example.com/oauth/token", "POST"],
		["https://user:password@auth.openai.com/oauth/token", "POST"],
		[`${tokenURL}/extra`, "POST"], [tokenURL + "?target=other", "POST"], [tokenURL + "#other", "POST"],
		[`${origin}/oauth/authorize`, "POST"],
		[`${origin}/api/accounts/oauth/token`, "POST"],
		["https://api.openai.com/v1/responses", "POST"],
	])("不放行非 Codex 认证请求 %s %s", async (url, method) => {
		await expect(fetch(url, { method })).rejects.toThrow("订阅端点");
		expect(transport).not.toHaveBeenCalled();
	});

	it("认证白名单不绕过模型请求的会话绑定", async () => {
		await fetch(tokenURL, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: secret }) });
		await expect(fetch("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST", body: JSON.stringify({ model: "gpt-6-astra" }),
		})).rejects.toThrow("未绑定");
		expect(transport).toHaveBeenCalledTimes(1);
	});
});
