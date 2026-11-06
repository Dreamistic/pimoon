import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createCrudTestContext } from "./crud-fixtures.ts";
import { expectFailure } from "./result-fixtures.ts";

const context = createCrudTestContext();
it.each(["", "原文😀", "one\r\ntwo\nthree\r", "\ufeff{\"name\":\"原文😀\"}\r\n"])("原文保留完整 UTF-8、BOM 与换行 %j", async text => {
 await writeFile(path.join(context.workspace, "raw.txt"), text);
 expect(await context.read({ path: "raw.txt", mode: "raw" })).toMatchObject({ raw: true, segments: [{ content: text }], truncated: false });
});
it("原文不使用展示行数预算，读取版本可直接用于编辑", async () => {
 const file = path.join(context.workspace, "raw.txt");
 const text = "one\r\ntwo\r\n";
 await writeFile(file, text);
 await context.useConfig({ limits: { read_lines: 1 } });
 expect(await context.read({ path: "raw.txt", mode: "raw" })).toMatchObject({ segments: [{ content: text }], truncated: false });
 const edited = await context.edit({ path: "raw.txt", edits: [{ old: "two", new: "changed" }] });
 expect(edited).toHaveProperty("status", "applied");
 expect(await readFile(file, "utf8")).toBe("one\r\nchanged\r\n");
});
it("原文观测不能覆盖之后发生的外部修改", async () => {
 const file = path.join(context.workspace, "raw.txt");
 await writeFile(file, "old");
 await context.read({ path: "raw.txt", mode: "raw" });
 await writeFile(file, "external");
 expect(await context.edit({ path: "raw.txt", edits: [{ old: "external", new: "bad" }] })).toHaveProperty("status", "failed");
 expect(await readFile(file, "utf8")).toBe("external");
});
it.each([{ lines: "1" }, { pages: "1" }])("raw 拒绝范围 %j", async range => {
 expectFailure(await context.read({ path: "missing.txt", mode: "raw", ...range }), "INVALID_OPERATION");
});
it.each([
 ["image.gif", Buffer.from("R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64"), "BINARY_FILE_UNSUPPORTED"],
 ["doc.pdf", Buffer.from("%PDF-1.7\n"), "BINARY_FILE_UNSUPPORTED"],
 ["binary.bin", Buffer.from([0, 1, 2]), "BINARY_FILE_UNSUPPORTED"],
 ["invalid.txt", Buffer.from([0xc3, 0x28]), "ENCODING_UNSUPPORTED"],
] as const)("raw 拒绝非文本或非法 UTF-8 %s", async (file, bytes, code) => {
 await writeFile(path.join(context.workspace, file), bytes);
 expectFailure(await context.read({ path: file, mode: "raw" }), code);
});
it("raw 超过 4 MiB 或配置上限失败，不截断为成功文本", async () => {
 await writeFile(path.join(context.workspace, "large.txt"), "a".repeat(4 * 1024 * 1024 + 1));
 expectFailure(await context.read({ path: "large.txt", mode: "raw" }), "OUTPUT_LIMIT_EXCEEDED");
 await context.useConfig({ limits: { read_max_file_bytes: 1024 } });
 await writeFile(path.join(context.workspace, "small.txt"), "a".repeat(1025));
 expectFailure(await context.read({ path: "small.txt", mode: "raw" }), "OUTPUT_LIMIT_EXCEEDED");
});
it("raw 缺失文件沿用文件工具错误码", async () => {
 expectFailure(await context.read({ path: "missing.txt", mode: "raw" }), "FILE_NOT_FOUND");
});

it("取消原文读取不登记可编辑版本",async()=>{
 await writeFile(path.join(context.workspace,"cancelled.txt"),"old");
 const controller=new AbortController();controller.abort();
 expectFailure(await context.read({path:"cancelled.txt",mode:"raw"},{signal:controller.signal}),"OPERATION_ABORTED");
 expect(await context.edit({path:"cancelled.txt",edits:[{old:"old",new:"bad"}]})).toHaveProperty("status","failed");
});
