import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushTelemetry, record, telemetryDirectory } from "../../src/pimoon/telemetry.ts";

const origin = "https://auth.openai.com";
const tokenURL = `${origin}/oauth/token`;
const userCodeURL = `${origin}/api/accounts/deviceauth/usercode`;
const deviceTokenURL = `${origin}/api/accounts/deviceauth/token`;
const secret = "SYNTHETIC_OAUTH_PRIVATE_SENTINEL";
const json = (value: unknown) => new Response(JSON.stringify(value));
const oauth = openaiCodexProvider().auth.oauth;
if (!oauth) throw new Error("Codex OAuth provider is required");
const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const original = globalThis.fetch;
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
	transport.mockReset();
	transport.mockImplementation(async () => new Response(JSON.stringify({ access_token: access, refresh_token: "AUTH_REFRESH_PRIVATE_SENTINEL", expires_in: 3600 })));
	globalThis.fetch = transport;
});
afterEach(() => { globalThis.fetch = original; });

describe("桌面 Codex 认证", () => {
	it("SDK 设备码登录、令牌交换与刷新正常完成，且不记录凭据", async () => {
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
		for (const [, options] of transport.mock.calls) expect(options).toMatchObject({ method: "POST", signal });
		expect(String(transport.mock.calls[2]?.[1]?.body)).toContain("grant_type=authorization_code");
		expect(String(transport.mock.calls[3]?.[1]?.body)).toContain("grant_type=refresh_token");
		record("auth_device_boundary_test");
		await flushTelemetry();
		const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
		const text = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("");
		expect(text).not.toContain(secret);
		expect(text).not.toContain(access);
	});


	it("真实 SDK 可自动刷新令牌，无需模型会话绑定且不记录凭据", async () => {
		const oauth = openaiCodexProvider().auth.oauth;
		if (!oauth) throw new Error("Codex OAuth unavailable");
		const signal = new AbortController().signal;
		const before = Date.now();
		const result = await oauth.refresh({ type: "oauth", access: "expired", refresh: "AUTH_OLD_PRIVATE_SENTINEL", expires: 0 }, signal);
		expect(result).toMatchObject({ access, refresh: "AUTH_REFRESH_PRIVATE_SENTINEL", accountId: "synthetic-account" });
		expect(result.expires).toBeGreaterThanOrEqual(before + 3600_000);
		expect(transport).toHaveBeenCalledExactlyOnceWith(tokenURL, expect.objectContaining({ method: "POST", signal }));
		const options = transport.mock.calls[0]?.[1];
		expect(options?.body).toBeInstanceOf(URLSearchParams);
		const form = new URLSearchParams(String(options?.body));
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("AUTH_OLD_PRIVATE_SENTINEL");
		record("auth_boundary_test");
		await flushTelemetry();
		const files = (await fs.readdir(telemetryDirectory)).filter(file => file.endsWith(".jsonl"));
		const text = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("");
		for (const secret of [access, "AUTH_OLD_PRIVATE_SENTINEL", "AUTH_REFRESH_PRIVATE_SENTINEL"]) expect(text).not.toContain(secret);
	});

});
