import { expect, it } from "vitest";
import { CodeActParser, type CodeActChunk } from "../../src/pimoon/codeact/parser.ts";

function parse(parts: string[]) {
	const parser = new CodeActParser();
	const chunks = parts.flatMap(part => parser.feed(part));
	chunks.push(...parser.finish());
	return { parser, chunks, text: join(chunks, "text"), code: join(chunks, "code") };
}
const join = (chunks: CodeActChunk[], type: "text" | "code") => chunks.filter(chunk => chunk.type === type).map(chunk => "text" in chunk ? chunk.text : "").join("");

it("任意分片、CRLF、Unicode 与结束标记同行到达的后缀均不改变提交代码", () => {
	const source = "准备\r\n<execute>\r\nvalue='原文 </execute> 字符串'\r\nvalue\r\n</execute>\r\n不应展示或执行的后缀";
	for (let split = 0; split <= source.length; split++) {
		const result = parse([source.slice(0, split), source.slice(split)]);
		expect(result.text).toBe("准备\r\n");
		expect(result.code).toBe("value='原文 </execute> 字符串'\r\nvalue\r\n");
		expect(result.parser.closed).toBe(true);
		expect(result.chunks.filter(chunk => chunk.type === "open")).toHaveLength(1);
	}
	expect(parse([...source]).parser.closed).toBe(true);
});

it.each([" trailing metadata", "\tpostscript", "postscript", "\r\npostscript"])("结束标记后的同分片或后续文字不属于源码：%j", suffix => {
	const prefix = "准备\n<execute>\nvalue=42\nvalue\n</execute>";
	const source = prefix + suffix + "\nshould_not_run()";
	for (let split = 0; split <= source.length; split++) {
		const result = parse([source.slice(0, split), source.slice(split)]);
		expect(result.code).toBe("value=42\nvalue\n");
		expect(result.parser.consumed).toBe(prefix.length);
		expect(result.chunks.filter(chunk => chunk.type === "close")).toHaveLength(1);
	}
	expect(parse([...source]).code).toBe("value=42\nvalue\n");
});

it.each(["</exec", "</executeX>", " </execute>"])("真正缺失或损坏的结束标记不自动补齐：%s", marker => {
	expect(() => parse(["<execute>\nchange()\n" + marker])).toThrow("未闭合");
});

it("正文立即流出，保留可能的分片标记；未闭合、空块和超限代码不提交", () => {
	const parser = new CodeActParser();
	expect(join(parser.feed("普通正文"), "text")).toBe("普通正文");
	expect(join(parser.feed("\n<exec"), "text")).toBe("\n");
	expect(parser.feed("ute>\nvalue=42").some(chunk => chunk.type === "open")).toBe(true);
	expect(() => parser.finish()).toThrow("未闭合");
	expect(() => parse(["<execute>\n</execute>"])).toThrow("为空");
	expect(() => parse(["<execute>\n" + "x".repeat(1024 * 1024 + 1)])).toThrow("超过");
});

it("正文块边界不合成换行、不打断源码；提交偏移只统计原文", () => {
	const parser = new CodeActParser();
	const chunks = parser.feed("说明无换行");
	chunks.push(...parser.textBoundary(), ...parser.feed("<execute>\nx="));
	chunks.push(...parser.textBoundary(), ...parser.feed("42\nx\n</execute> suffix"));
	expect(join(chunks, "text")).toBe("说明无换行");
	expect(join(chunks, "code")).toBe("x=42\nx\n");
	expect(parser.consumed).toBe("说明无换行<execute>\nx=42\nx\n</execute>".length);
});

it.each(["```python", "<thinking>"])("正文块边界保留示例保护状态：%s", example => {
	const parser = new CodeActParser();
	const chunks = parser.feed(example);
	chunks.push(...parser.textBoundary(), ...parser.feed("<execute>\nignored()\n</execute>"), ...parser.finish());
	expect(join(chunks, "code")).toBe("");
	expect(parser.closed).toBe(false);
});

it("Markdown 围栏和嵌套 thinking 内的属性示例不执行；缩进不是执行协议", () => {
	const examples = "```python\n<execute desc=\"example\" confirm=\"no\">\nexample()\n</execute>\n```\n<thinking>\n<thinking>\n</thinking>\n<execute desc=\"ignored\">\nignored()\n</execute>\n</thinking>\n <execute>\n";
	const result = parse([...examples + "<execute>\nactual()\n</execute>"]);
	expect(result.text).toBe(examples);
	expect(result.code).toBe("actual()\n");
});

it("desc/confirm 在所有分片边界保留 Unicode 和实体，属性不进入源码", () => {
	const source = '<execute desc="检查 &quot;配置&quot; &amp; 路径😀" confirm=\'确认&#xFF1F;\'>\r\nvalue=42\r\n</execute> ignored';
	for (let split = 0; split <= source.length; split++) {
		const result = parse([source.slice(0, split), source.slice(split)]);
		expect(result.text).toBe("");
		expect(result.code).toBe("value=42\r\n");
		expect(result.chunks.find(chunk => chunk.type === "open")).toEqual({ type: "open", metadata: { desc: '检查 "配置" & 路径😀', confirm: "确认？" } });
		expect(result.parser.consumed).toBe(source.indexOf(" ignored"));
	}
	expect(parse([...source]).parser.closed).toBe(true);
});

it.each([
	'<execute confirm="">', '<execute confirm="  ">', '<execute confirm="a" confirm="b">',
	'<execute desc="a" desc="b">', '<execute language="bash">', '<execute confirm=no>',
	'<execute confirm="missing>', '<execute confirm="x">suffix', '<execute desc="a<b">',
	'<execute confirm="&#10;">', '<execute desc="&#xD800;">', '<execute confirm="' + "x".repeat(1001) + '">',
	'<execute desc="' + "x".repeat(161) + '">',
])("无效属性拒绝整块，不能退化为无确认执行：%s", tag => {
	expect(() => parse([...`${tag}\nwrite()\n</execute>`])).toThrow("代码未执行");
});

it("未闭合开始标记和超长属性在执行前失败，普通文本仍立即流出", () => {
	expect(() => parse(['<execute confirm="未闭合'])).toThrow("代码未执行");
	expect(() => parse(['<execute desc="' + "x".repeat(4096)])).toThrow("过长");
	const parser = new CodeActParser();
	expect(join(parser.feed("普通正文😀"), "text")).toBe("普通正文😀");
	expect(join(parser.feed('\n<execute desc="尚未完整'), "text")).toBe("\n");
});
