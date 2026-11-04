import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageService } from "../../src/harness/usage/service.ts";
import type { UsageContext } from "../../src/harness/usage/client.ts";
import { installModelBoundary } from "../../src/pimoon/network.ts";

const origin = "https://chatgpt.com";
const usagePath = "/backend-api/wham/usage";
const creditsPath = "/backend-api/wham/rate-limit-reset-credits";
const consumePath = `${creditsPath}/consume`;
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
const context: UsageContext = {
	modelRegistry: {
		getProviderAuth: async (id) => id === "openai-codex" ? { source: "OAuth", auth: { apiKey: token } } : undefined,
	},
};
const originalFetch = globalThis.fetch;
const transport = vi.fn<typeof fetch>();
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
	transport.mockReset();
	transport.mockImplementation(async (input) => {
		const url = new URL(typeof input === "object" && "url" in input ? input.url : String(input));
		if (url.pathname === usagePath) return json({
			plan_type: "prolite",
			rate_limit: {
				primary_window: { used_percent: 41, limit_window_seconds: 604_800, reset_at: 1_794_209_760 },
				secondary_window: null,
			},
			credits: { balance: "0", has_credits: false, unlimited: false },
			rate_limit_reset_credits: { available_count: 1 },
		});
		if (url.pathname === creditsPath) return json({ available_count: 1, credits: [{
			id: "synthetic-credit", status: "available", granted_at: "2026-11-02T00:00:00Z", expires_at: "2026-12-02T00:00:00Z",
		}] });
		if (url.pathname === consumePath) return json({ code: "nothing_to_reset" });
		throw new Error("Unexpected test endpoint");
	});
	globalThis.fetch = transport;
	installModelBoundary();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("桌面订阅用量网络边界", () => {
	it("安装桌面边界后仍可查询套餐、周额度与重置卡并提交兑换", async () => {
		const service = new UsageService();
		const snapshot = await service.load(context, { refresh: true, signal: undefined });
		expect(snapshot.providers).toEqual([expect.objectContaining({
			id: "openai-codex", status: "ok", plan: "prolite",
			windows: [expect.objectContaining({ sectionLabel: "Plan quota", label: "Week", usedPercent: 41 })],
			details: [{ label: "Account credits", value: "0 · unavailable" }],
			resetCredits: { availableCount: 1, credits: [{
				id: "synthetic-credit", status: "available", grantedAt: "2026-11-02T00:00:00.000Z", expiresAt: "2026-12-02T00:00:00.000Z",
			}] },
		})]);
		expect(await service.consumeCodexCredit(context, {
			creditId: "synthetic-credit", requestId: "synthetic-request", signal: undefined,
		})).toBe("nothing_to_reset");
		expect(transport).toHaveBeenCalledTimes(3);
		for (const [, options] of transport.mock.calls) {
			expect(options?.redirect).toBe("error");
			const headers = new Headers(options?.headers);
			expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
			expect(headers.get("ChatGPT-Account-Id")).toBe("synthetic-account");
		}
		expect(transport.mock.calls[2]?.[1]).toMatchObject({
			method: "POST", body: JSON.stringify({ credit_id: "synthetic-credit", redeem_request_id: "synthetic-request" }),
		});
	});

	it("重置卡明细不可用时仍显示套餐与可用数量", async () => {
		transport.mockImplementation(async (input) => String(input).endsWith(creditsPath)
			? new Response(null, { status: 503 })
			: json({ plan_type: "prolite", rate_limit_reset_credits: { available_count: 1 } }));
		const snapshot = await new UsageService().load(context, { refresh: true, signal: undefined });
		expect(snapshot.providers[0]).toMatchObject({ status: "ok", plan: "prolite", resetCredits: { availableCount: 1, credits: undefined } });
	});

	it("支持 URL、Request 和显式覆盖的方法，始终禁止重定向", async () => {
		await fetch(new URL(`${origin}${usagePath}`), { redirect: "follow" });
		await fetch(new Request(`${origin}${creditsPath}`));
		await fetch(new Request(`${origin}${consumePath}`, { method: "POST", body: "{}" }));
		await fetch(new Request(`${origin}${usagePath}`, { method: "POST" }), { method: "GET" });
		expect(transport).toHaveBeenCalledTimes(4);
		expect(transport.mock.calls.every(([, options]) => options?.redirect === "error")).toBe(true);
		await expect(fetch(new Request(`${origin}${usagePath}`), { method: "DELETE" })).rejects.toThrow("订阅端点");
		expect(transport).toHaveBeenCalledTimes(4);
	});

	it.each([
		[`${origin}${usagePath}`, "POST"],
		[`${origin}${creditsPath}`, "POST"],
		[`${origin}${consumePath}`, "GET"],
		[`${origin}${consumePath}`, "DELETE"],
		[`http://chatgpt.com${usagePath}`, "GET"],
		[`https://chatgpt.com:444${usagePath}`, "GET"],
		[`https://chatgpt.com.example.com${usagePath}`, "GET"],
		[`https://example.com${usagePath}`, "GET"],
		[`https://user:password@chatgpt.com${usagePath}`, "GET"],
		[`${origin}${usagePath}/extra`, "GET"],
		[`${origin}${usagePath}?target=other`, "GET"],
		[`${origin}${usagePath}#other`, "GET"],
		[`${origin}/backend-api/wham/other`, "GET"],
	])("不放行非精确用量请求 %s %s", async (url, method) => {
		await expect(fetch(url, { method })).rejects.toThrow("订阅端点");
		expect(transport).not.toHaveBeenCalled();
	});

	it("用量白名单不会绕过模型请求的会话绑定", async () => {
		await expect(fetch(`${origin}/backend-api/codex/responses`, {
			method: "POST", body: JSON.stringify({ model: "gpt-6-astra" }),
		})).rejects.toThrow("未绑定");
		expect(transport).not.toHaveBeenCalled();
	});
});
