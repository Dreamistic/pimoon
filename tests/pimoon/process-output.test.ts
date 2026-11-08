import { expect, it } from "vitest";
import { decodeOutput, outputDecoder } from "../../src/pimoon/codeact/process-output.ts";

it("严格 UTF-8 优先，stdout/stderr 可各自选择本地代码页", () => {
	expect(decodeOutput(Buffer.from("中文😀"), undefined, "cp936")).toEqual({ text: "中文😀" });
	expect(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), undefined, "cp936")).toEqual({ text: "中文" });
	expect(decodeOutput(Buffer.from([0xc3, 0xa9]), "windows-1252")).toEqual({ text: "Ã©" });
	expect(decodeOutput(Buffer.from([0xc3, 0xa9]))).toEqual({ text: "é" });
});
it("显式字符集不再猜测；非法字节明确失败而非替换", () => {
	expect(decodeOutput(Buffer.from([0xd6, 0xd0]), "utf-8", "cp936").error).toContain("already ran");
	expect(decodeOutput(Buffer.from([0x81]), undefined, "cp936")).toMatchObject({ text: "", error: expect.stringContaining("original bytes") });
	expect(decodeOutput(Buffer.from([0x81]))).toHaveProperty("error");
	expect(() => outputDecoder("not-a-codec")).toThrow("Unsupported process encoding");
	expect(decodeOutput(Buffer.from("valid"), undefined, "not-a-codec")).toEqual({ text: "valid" });
});
it("仅字节预算截断的流舍弃不完整尾字符，完整流仍严格报错", () => {
	expect(decodeOutput(Buffer.from([0xe4, 0xb8]), undefined, "cp936", true)).toEqual({ text: "" });
	expect(decodeOutput(Buffer.from([0xe4, 0xb8]))).toHaveProperty("error");
	expect(decodeOutput(Buffer.from([0xd6]), "gbk", undefined, true)).toEqual({ text: "" });
});
it("保留原始 BOM 和合法替换字符；显式 utf-8-sig 才去 BOM", () => {
	const bytes = Buffer.from("\ufeff原文�");
	expect(decodeOutput(bytes)).toEqual({ text: "\ufeff原文�" });
	expect(decodeOutput(bytes, "utf-8-sig")).toEqual({ text: "原文�" });
});
