import { randomUUID } from "node:crypto";
import { lstat, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const scope = vi.hoisted(() => ({ home: `${process.cwd()}/.tmp/tests/approval-traces-${Date.now()}-${Math.random().toString(16).slice(2)}` }));
vi.mock("../../../src/pimoon/profile.ts", () => ({ pimoonHome: scope.home }));
import { appendApprovalTrace, listApprovalTraces, readApprovalTrace, removeApprovalTraces, sanitizeApprovalTrace } from "../../../src/harness/approval/trace-store.ts";
const config = { enabled: true, retention_days: 7, max_mb: 1 };
const id = () => "20261109-" + randomUUID();
afterEach(async () => { await removeApprovalTraces(); });
it("结构化环境、认证头、文本秘密及 URL 凭据脱敏，保留可复盘字段", () => {
	const result = sanitizeApprovalTrace({ env: { TOKEN: "env-secret" }, authorization: "header-secret", text: `Bearer bearer-secret; token="literal-secret" https://user:password@example.invalid/path?api_key=query-secret`, code: "print(42)", phase: "response" });
	const text = JSON.stringify(result.value);
	for (const value of ["env-secret", "header-secret", "bearer-secret", "literal-secret", "user:password", "query-secret"]) expect(text).not.toContain(value);
	expect(text).toContain("print(42)"); expect(result.redactions).toBeGreaterThan(4);
});
it("默认写入本机详细事件，禁用不写；读取只接受记录 ID", async () => {
	const first = id(), disabled = id();
	await appendApprovalTrace(first, "request", { prompt: "fixture", payload: { action: "write" } }, config);
	await appendApprovalTrace(first, "response", { text: "invalid-json" }, config);
	await appendApprovalTrace(disabled, "request", { text: "not stored" }, { ...config, enabled: false });
	expect((await listApprovalTraces()).map(row => row.id)).toEqual([first]);
	expect((await readApprovalTrace(first)).events.map(event => event.phase)).toEqual(["request", "response"]);
	await expect(readApprovalTrace("../auth.json")).rejects.toThrow();
});
it("过期记录清理而不触及其他文件；清除只作用于详细诊断", async () => {
	const old = id(), recent = id();
	await appendApprovalTrace(old, "request", {}, config);
	const root = path.join(scope.home, "diagnostics", "approval");
	await writeFile(path.join(root, "keep.txt"), "unrelated");
	await utimes(path.join(root, old + ".jsonl"), new Date(0), new Date(0));
	await appendApprovalTrace(recent, "request", {}, config);
	expect((await listApprovalTraces()).map(row => row.id)).toEqual([recent]);
	await removeApprovalTraces(); expect(await readdir(root)).toContain("keep.txt");
});
it("容量达到上限时明确记录省略，单记录和总容量都受限", async () => {
	const record = id();
	for (let i = 0; i < 14; i++) await appendApprovalTrace(record, "response", { text: "x".repeat(64000) }, config);
	const detail = await readApprovalTrace(record);
	expect(detail.events.some(event => event.phase === "omitted" && event.truncated)).toBe(true);
	const info = await lstat(path.join(scope.home, "diagnostics", "approval", record + ".jsonl")); expect(info.size).toBeLessThanOrEqual(512 * 1024);
	for (let i = 0; i < 24; i++) await appendApprovalTrace(id(), "request", { text: "x".repeat(60000) }, config);
	const rows = await listApprovalTraces(); expect(rows.reduce((sum, row) => sum + row.bytes, 0)).toBeLessThanOrEqual(1024 * 1024);
});
