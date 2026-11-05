import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCrudTestContext } from "./crud-fixtures.ts";
import { expectFailure } from "./result-fixtures.ts";

const context = createCrudTestContext();

describe("精确编辑的 LF/CRLF 兼容", () => {
	it.each(["\n", "\r\n"])("统一换行 %j：预览与提交一致，保留 BOM、Unicode 与未编辑字节", async newline => {
		const target = path.join(context.workspace, "source.py");
		const original = "\ufeff" + ["# 中文😀", "value = 1", "keep = 3", ""].join(newline);
		await writeFile(target, original);
		await context.read({ path: "source.py" });
		const other = newline === "\n" ? "\r\n" : "\n";
		const params = { path: "source.py", edits: [{ old: `value = 1${other}`, new: `value = 2${other}added = 4${other}` }] };
		const preview = await context.preview(params);
		expect(preview).toMatchObject({ status: "preview", replacements: 1 });
		expect(await readFile(target, "utf8")).toBe(original);
		const applied = await context.edit(params);
		expect(applied).toMatchObject({ status: "applied", replacements: 1 });
		if ("diff" in preview && "diff" in applied) expect(applied.diff).toBe(preview.diff);
		expect(await readFile(target, "utf8")).toBe(original.replace(`value = 1${newline}`, `value = 2${newline}added = 4${newline}`));
	});

	it("单行匹配插入多行也保留文件 CRLF", async () => {
		const target = path.join(context.workspace, "source.txt");
		await writeFile(target, "old\r\nkeep\r\n");
		await context.read({ path: "source.txt" });
		expect(await context.edit({ path: "source.txt", edits: [{ old: "old", new: "one\ntwo" }] })).toMatchObject({ status: "applied" });
		expect(await readFile(target, "utf8")).toBe("one\r\ntwo\r\nkeep\r\n");
	});

	it("换行转换后仍拒绝歧义和重叠，replace_all 才修改全部", async () => {
		const target = path.join(context.workspace, "source.txt");
		const original = "same\r\nsame\r\n";
		await writeFile(target, original);
		await context.read({ path: "source.txt" });
		expectFailure(await context.edit({ path: "source.txt", edits: [{ old: "same\n", new: "x\n" }] }), "OLD_TEXT_NOT_UNIQUE");
		expectFailure(await context.edit({ path: "source.txt", edits: [
			{ old: "same\nsame\n", new: "x\n" }, { old: "same\n", new: "y\n", replace_all: true },
		] }), "OVERLAPPING_REPLACEMENTS");
		expect(await readFile(target, "utf8")).toBe(original);
		expect(await context.edit({ path: "source.txt", edits: [{ old: "same\n", new: "x\n", replace_all: true }] })).toMatchObject({ replacements: 2 });
		expect(await readFile(target, "utf8")).toBe("x\r\nx\r\n");
	});

	it("混合换行只提供换行漂移诊断，不自动写入", async () => {
		const target = path.join(context.workspace, "source.txt");
		const original = "first\r\nsecond\n";
		await writeFile(target, original);
		await context.read({ path: "source.txt" });
		const result = expectFailure(await context.edit({ path: "source.txt", edits: [{ old: "first\nsecond\n", new: "changed" }] }), "OLD_TEXT_NOT_FOUND");
		expect(result.error.details?.["reason"]).toBe("newline_drift");
		expect(await readFile(target, "utf8")).toBe(original);
	});

	it("不兼容缩进、内容空格或单独 CR，也不跳过版本检查", async () => {
		const target = path.join(context.workspace, "source.py");
		const original = "if ok:\r\n    value = 1\r\n";
		await writeFile(target, original);
		const params = { path: "source.py", edits: [{ old: "value = 1\n", new: "value = 2\n" }] };
		expectFailure(await context.edit(params), "READ_REQUIRED");
		await context.read({ path: "source.py" });
		for (const old of ["if ok:\n  value = 1\n", "value  = 1\n", "if ok:\r    value = 1\r"])
			expectFailure(await context.edit({ path: "source.py", edits: [{ old, new: "changed" }] }), "OLD_TEXT_NOT_FOUND");
		expect(await readFile(target, "utf8")).toBe(original);
		await writeFile(target, original + "# concurrent\r\n");
		expectFailure(await context.edit(params), "STALE_READ");
	});
});
