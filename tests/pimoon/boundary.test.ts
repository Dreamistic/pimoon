import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { installModelBoundary } from "../../src/pimoon/network.ts";
import { fingerprint, flushTelemetry, pimoonTelemetry, requestBindings, telemetryDirectory } from "../../src/pimoon/telemetry.ts";
import { userAgentConfigPath, userAgentPath } from "../../src/harness/config-loader.ts";
import { telemetryRunsDirectory, userHistoryPath, resourceCacheDirectory } from "../../src/harness/storage/paths.ts";
import { agentHome, pimoonHome } from "../../src/pimoon/profile.ts";
import { checkReadablePath, checkWritablePath } from "../../src/pimoon/paths.ts";
import { registerExtension } from "../helpers/extension.ts";
import { bindAuxiliaryRequest } from "../../src/pimoon/auxiliary-request.ts";

const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const payload = JSON.stringify({ model: "gpt-6-astra", input: "SYNTHETIC_PROMPT_SENTINEL_7b20" });
const original = globalThis.fetch;
const transport = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
beforeEach(() => {
	transport.mockClear(); requestBindings.clear(); globalThis.fetch = transport; installModelBoundary();
	requestBindings.set(fingerprint(payload).sha256, { allowed: true, model: "gpt-6-astra", labels: { session_id: "synthetic-session" } });
});
afterAll(() => { globalThis.fetch = original; });

describe("模型请求边界", () => {
	it("Sol 辅助请求有独立绑定，不替换 Astra 主模型绑定，且不能重放", async () => {
		const request = { model: "gpt-6.1-sol", input: "approval-fixture" };
		bindAuxiliaryRequest(request, { id: "gpt-6.1-sol", provider: "openai-codex" }, "approval-session");
		await fetch(endpoint, { method: "POST", body: JSON.stringify(request) });
		await fetch(endpoint, { method: "POST", body: payload });
		await expect(fetch(endpoint, { method: "POST", body: JSON.stringify(request) })).rejects.toThrow("未绑定");
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it("辅助绑定仍拒绝空会话与非订阅模型", async () => {
		const request = { model: "other", input: "approval-fixture" };
		bindAuxiliaryRequest(request, { id: "other", provider: "other" }, "session");
		await expect(fetch(endpoint, { method: "POST", body: JSON.stringify(request) })).rejects.toThrow("未绑定");
		bindAuxiliaryRequest(request, { id: "other", provider: "openai-codex" }, "");
		await expect(fetch(endpoint, { method: "POST", body: JSON.stringify(request) })).rejects.toThrow("未绑定");
		expect(transport).not.toHaveBeenCalled();
	});
	it("检查 Zstd 正文但不改变发送内容，并禁止重定向", async () => {
		const body = new Uint8Array(zstdCompressSync(payload));
		await fetch(endpoint, { method: "POST", body, headers: { "content-encoding": "zstd" } });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
		expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
	});
	it("支持 Request 对象，拒绝相同绑定的自动重放", async () => {
		await fetch(new Request(endpoint, { method: "POST", body: payload }));
		await expect(fetch(endpoint, { method: "POST", body: payload })).rejects.toThrow("未绑定");
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("不同模型、其他端点和无正文都不发送", async () => {
		const other = JSON.stringify({ model: "other" });
		requestBindings.set(fingerprint(other).sha256, { allowed: true, model: "gpt-6-astra", labels: {} });
		await expect(fetch(endpoint, { method: "POST", body: other })).rejects.toThrow("切换模型");
		await expect(fetch("https://example.com", { method: "POST", body: payload })).rejects.toThrow("订阅端点");
		await expect(fetch(endpoint)).rejects.toThrow("请求正文");
		expect(transport).not.toHaveBeenCalled();
	});
	it("手动选择 Sol 后按会话绑定发送，不替换模型", async () => {
		const body = JSON.stringify({ model: "gpt-6.1-sol", input: "synthetic" });
		requestBindings.set(fingerprint(body).sha256, { allowed: true, model: "gpt-6.1-sol", labels: {} });
		await fetch(endpoint, { method: "POST", body });
		expect(transport).toHaveBeenCalledTimes(1);
		expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
	});
	it("Sol 请求不能使用 Astra 会话的模型绑定", async () => {
		const body = JSON.stringify({ model: "gpt-6.1-sol" });
		requestBindings.set(fingerprint(body).sha256, { allowed: true, model: "gpt-6-astra", labels: {} });
		await expect(fetch(endpoint, { method: "POST", body })).rejects.toThrow("切换模型");
		expect(transport).not.toHaveBeenCalled();
	});
	it("未获许可的绑定不可发送，不再误报请求次数", async () => {
		requestBindings.set(fingerprint(payload).sha256, { allowed: false, model: "gpt-6-astra", labels: {} });
		await expect(fetch(endpoint, { method: "POST", body: payload })).rejects.toThrow("未绑定到允许的 Codex 会话");
		expect(transport).not.toHaveBeenCalled();
	});
	it("同轮超过20次请求仍可发送，逐次绑定与禁止重放保持生效", async () => {
		const { handlers } = registerExtension(pimoonTelemetry);
		const ctx = { cwd: process.cwd(), model: { id: "gpt-6.1-sol", provider: "openai-codex" },
			sessionManager: { getSessionId: () => "long-sol-run" } };
		await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "长任务回归" }, ctx);
		try {
			for (let index = 0; index < 25; index++) {
				const request = { model: "gpt-6.1-sol", input: `step-${index}` };
				await handlers.get("before_provider_request")?.({ payload: request }, ctx);
				await fetch(endpoint, { method: "POST", body: JSON.stringify(request) });
			}
			expect(transport).toHaveBeenCalledTimes(25);
			await expect(fetch(endpoint, { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol", input: "step-24" }) })).rejects.toThrow("未绑定");
			expect(transport).toHaveBeenCalledTimes(25);
		} finally { await handlers.get("session_shutdown")?.({ reason: "test" }, ctx); }
	});
	it.each(["missing-run", "other-provider"])("%s 不因移除次数限制而获得许可", async condition => {
		const { handlers } = registerExtension(pimoonTelemetry);
		const ctx = { cwd: process.cwd(), model: { id: "gpt-6.1-sol", provider: condition === "other-provider" ? "other" : "openai-codex" },
			sessionManager: { getSessionId: () => condition } };
		if (condition === "other-provider") await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "test" }, ctx);
		try {
			const request = { model: "gpt-6.1-sol", input: condition };
			await handlers.get("before_provider_request")?.({ payload: request }, ctx);
			await expect(fetch(endpoint, { method: "POST", body: JSON.stringify(request) })).rejects.toThrow("未绑定");
			expect(transport).not.toHaveBeenCalled();
		} finally { await handlers.get("session_shutdown")?.({ reason: "test" }, ctx); }
	});
	it("压缩解码也受16MiB上限约束", async () => {
		await expect(fetch(endpoint, { method: "POST", body: new Uint8Array(zstdCompressSync("x".repeat(16 * 1024 * 1024 + 1))), headers: { "content-encoding": "zstd" } })).rejects.toThrow();
		expect(transport).not.toHaveBeenCalled();
	});
	it("本地遥测没有正文或请求头", async () => {
		await fetch(endpoint, { method: "POST", body: payload, headers: { Authorization: "synthetic-private-header" } });
		await flushTelemetry();
		const files = await fs.readdir(telemetryDirectory);
		const text = (await Promise.all(files.map(file => fs.readFile(path.join(telemetryDirectory, file), "utf8")))).join("");
		expect(text).not.toContain("SYNTHETIC_PROMPT_SENTINEL_7b20");
		expect(text).not.toContain("synthetic-private-header");
		expect(text).toContain("synthetic-session");
	});
});

it("配置、历史、遥测与缓存都使用 pimoon 根目录而不是 ~/.pi", () => {
	expect(userAgentConfigPath("gui.jsonc", "PIMOON_TEST_UNUSED_CONFIG")).toBe(path.join(agentHome, "configs/gui.jsonc"));
	expect(userAgentPath("mcp.jsonc", "PIMOON_TEST_UNUSED_CONFIG")).toBe(path.join(agentHome, "mcp.jsonc"));
	for (const target of [telemetryRunsDirectory(), userHistoryPath(), resourceCacheDirectory()]) expect(path.relative(pimoonHome, target)).not.toMatch(/^\.\./);
});

it("普通写入跨工作区和 junction，凭据与控制面仍受保护", async () => {
	const parent = path.resolve(".tmp/tests/pimoon-paths"); await fs.mkdir(parent, { recursive: true });
	const folder = await fs.mkdtemp(path.join(parent, "case-"));
	const cwd = path.join(folder, "workspace"), outside = path.join(folder, "outside");
	await fs.mkdir(cwd); await fs.mkdir(outside); await fs.symlink(outside, path.join(cwd, "escape"), "junction");
	await expect(checkWritablePath(cwd, "new/future.txt", [])).resolves.toBeUndefined();
	await expect(checkWritablePath(cwd, "../outside/new.txt", [])).resolves.toBeUndefined();
	await expect(checkWritablePath(cwd, "escape/future.txt", [])).resolves.toBeUndefined();
	await expect(checkWritablePath(cwd, "escape/future.txt", [outside])).rejects.toThrow("受保护");
	await expect(checkWritablePath(cwd, path.join(agentHome, "configs/approval-gate.jsonc"), [])).rejects.toThrow("受保护");
	await expect(checkReadablePath(cwd, "//untrusted-host/share/file", [])).rejects.toThrow("网络");
});
