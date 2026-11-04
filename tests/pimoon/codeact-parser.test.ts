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

it("正文立即流出，保留可能的分片标记；未闭合、空块和超限代码不提交", () => {
	const parser = new CodeActParser();
	expect(join(parser.feed("普通正文"), "text")).toBe("普通正文");
	expect(join(parser.feed("\n<exec"), "text")).toBe("\n");
	expect(parser.feed("ute>\nvalue=42").some(chunk => chunk.type === "open")).toBe(true);
	expect(() => parser.finish()).toThrow("未闭合");
	expect(() => parse(["<execute>\n</execute>"])).toThrow("为空");
	expect(() => parse(["<execute>\n" + "x".repeat(1024 * 1024 + 1)])).toThrow("超过");
});

it("Markdown 围栏和嵌套 thinking 内的示例不执行；缩进与属性不是执行协议", () => {
	const examples = "```python\n<execute>\nexample()\n</execute>\n```\n<thinking>\n<thinking>\n</thinking>\n<execute>\nignored()\n</execute>\n</thinking>\n <execute>\n<execute desc=\"example\">\n";
	const result = parse([...examples + "<execute>\nactual()\n</execute>"]);
	expect(result.text).toBe(examples);
	expect(result.code).toBe("actual()\n");
});
