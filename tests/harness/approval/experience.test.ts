import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ApprovalExperiences } from "../../../src/harness/approval/experience.ts";
import type { ApprovalRequest } from "../../../src/harness/approval/types.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("approval-experience-");
const request = (argv = ["git", "status"], cwd = "D:/fixture"): ApprovalRequest => ({
	tool: "process_run", cwd, detail: { argv, env: { TOKEN: "environment-secret" } }, units: [],
});
const store = () => new ApprovalExperiences(path.join(temp.path, "rules.jsonc"));

it("跨实例恢复合并的实际决定，不保存命令、工作区、自由意见或环境值", async () => {
	const first = store(), operation = request(["git", "status", "--private-sentinel"]);
	await first.remember(operation, { decision: "approved", scope: "once", feedback: "private-feedback" });
	await store().remember(operation, { decision: "approved", scope: "once" });
	expect(await store().relevant(operation)).toMatchObject([{ decision: "approved", scope: "once", count: 2, sameFamily: true }]);
	const text = await readFile(first.file, "utf8");
	for (const sentinel of ["private-sentinel", "environment-secret", "private-feedback", "D:/fixture"]) expect(text).not.toContain(sentinel);
	await expect(readFile(path.join(temp.path, "rules.jsonc"))).rejects.toThrow();
});

it("相似操作按家族检索，但不跨工作区或工具，取消不产生经验", async () => {
	const history = store();
	await history.remember(request(), { decision: "approved", scope: "once" });
	await history.remember(request(["git", "diff"]), { decision: "rejected" });
	await history.remember(request(["git", "log"]), { decision: "cancelled" });
	expect(await history.relevant(request(["git", "status", "--short"]))).toMatchObject([{ sameFamily: true }, { sameFamily: false }]);
	expect(await history.relevant(request(["git", "status"], "D:/other"))).toEqual([]);
	expect(await history.relevant({ tool: "write", cwd: "D:/fixture", detail: { path: "a.txt", content: "" }, units: [] })).toEqual([]);
});

it("多个实例并发保存不丢失决定，意见和授权范围不互相覆盖", async () => {
	await Promise.all(Array.from({ length: 10 }, () => store().remember(request(), { decision: "approved", scope: "once" })));
	await store().remember(request(), { decision: "rejected" });
	const entries = await store().relevant(request());
	expect(entries).toMatchObject([{ decision: "rejected", count: 1 }, { decision: "approved", scope: "once", count: 10 }]);
});

it("保留数量有上限，过期案例排除，损坏文件不静默覆盖", async () => {
	const history = store();
	for (let index = 0; index < 132; index++) await history.remember(request(["git", "status", String(index)]), { decision: "approved", scope: "once" });
	const data = JSON.parse(await readFile(history.file, "utf8")) as { entries: unknown[] };
	expect(data.entries).toHaveLength(128);
	vi.useFakeTimers();
	try { vi.setSystemTime(Date.now() + 91 * 24 * 60 * 60_000); expect(await history.relevant(request())).toEqual([]); }
	finally { vi.useRealTimers(); }
	await writeFile(history.file, '{"entries":[{"decision":"approved"}]}');
	await expect(history.relevant(request())).rejects.toThrow("Invalid");
	await expect(history.remember(request(), { decision: "approved" })).rejects.toThrow("Invalid");
	expect(await readFile(history.file, "utf8")).toContain('"entries":[{"decision"');
});

it("保存失败可恢复，既有授权文件保持不变", async () => {
	const history = store();
	await writeFile(path.join(temp.path, "rules.jsonc"), '{"rules":[]}');
	await mkdir(history.file);
	await expect(history.remember(request(), { decision: "approved" })).rejects.toThrow();
	expect(await readFile(path.join(temp.path, "rules.jsonc"), "utf8")).toBe('{"rules":[]}');
});
