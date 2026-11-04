import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { grepWorkspaceFiles } from "../../helpers/grep-tool.ts";
import { createGrepTestContext, expectGrepSuccess } from "./grep-fixtures.ts";
import { GrepLineMatcher } from "../../../src/harness/file-tools/grep/regex-matcher.ts";

// 无需 worker 的查询应在 worker 启动不可用时仍能完成真实文件搜索。
vi.mock("../../../src/harness/worker-runtime/typescript-worker.ts", () => ({ createTypeScriptWorker: () => { throw new Error("worker must not start"); } }));
const context = createGrepTestContext();
describe("纯文本分支搜索快路径", () => {
	it("多关键词仍保留正则分支顺序、大小写与 Unicode", async () => {
		await writeFile(path.join(context.workspace, "fixture.txt"), "prefix\nscopedModels\n中文\nSCOPEDMODELS\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(context.workspace, { query: "enabledModels|selectedModels|scopedModels|中文" }));
		expect(result.stats.text_hits).toBe(2);
		const matcher = new GrepLineMatcher(/foo|foobar|中文/u, false);
		try { expect(await matcher.match(["foobar", "a中文", "FOO"])).toEqual([{ start: 0, end: 3 }, { start: 1, end: 3 }, undefined]); }
		finally { matcher.dispose(); }
	});
});
