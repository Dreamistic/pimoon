import { expect, it } from "vitest";
import { MarkdownText, StreamingText } from "../../../../../src/gui/frontend/ui/content/markdown.tsx";
import { CodeBlock } from "../../../../../src/gui/frontend/ui/content/code-block.tsx";
import { fileLanguage } from "../../../../../src/gui/frontend/ui/content/code-highlight.ts";
import { TooltipProvider } from "../../../../../src/gui/frontend/ui/tooltip.tsx";
import { useReactFixture } from "../../../helpers/react-fixture.ts";

const render = useReactFixture();

it("SSE 逐段追加时，未闭合代码块已上色，结束时保留同一代码节点", async () => {
	const view = (text: string, active: boolean) => <TooltipProvider><StreamingText text={text} active={active} /></TooltipProvider>;
	await render(view('```ts\nconst answer = 42;', true));
	const block = document.querySelector(".code-block");
	const pre = block?.querySelector("pre");
	expect(block?.querySelector(".token.keyword")?.textContent).toBe("const");
	expect(block?.querySelector(".token.number")?.textContent).toBe("42");
	await render(view('```ts\nconst answer = 42;\nconsole.log("你好");', true));
	expect(document.querySelector(".code-block pre")).toBe(pre);
	expect(block?.querySelector(".token.string")?.textContent).toBe('"你好"');
	await render(view('```ts\nconst answer = 42;\nconsole.log("你好");\n```\n\n后续正文', false));
	expect(document.querySelector(".code-block pre")).toBe(pre);
	expect(document.body.textContent).toContain("后续正文");
	expect(block?.querySelector('[aria-label="复制ts"]')).not.toBeNull();
});

it("流式 Python 的不完整字符串不会抛错或把代码当作 HTML", async () => {
	await render(<TooltipProvider><MarkdownText text={'```python\nfor i in range(3):\n    print("<script>'} streaming /></TooltipProvider>);
	expect(document.querySelector(".token.keyword")?.textContent).toBe("for");
	expect(document.querySelector("pre")?.textContent).toContain('<script>');
	expect(document.querySelector("script")).toBeNull();
});

it.each([
	["typescript", "const value = 42;"],
	["python", 'print("hello")'],
	["powershell", '$value = "hello"'],
	["java", 'class Demo { String value = "hello"; }'],
	["sql", "SELECT name FROM users WHERE id = 42;"],
])("%s 代码块输出语法 token", async (language, text) => {
	await render(<TooltipProvider><CodeBlock language={language} text={text} /></TooltipProvider>);
	expect(document.querySelector("pre")?.textContent).toBe(text);
	expect(document.querySelectorAll(".token").length).toBeGreaterThan(0);
});

it("无语言和未知语言保持原文，不误判普通输出", async () => {
	await render(<TooltipProvider><MarkdownText text={'```unknown-language\n<script>plain & text</script>\n```'} streaming /></TooltipProvider>);
	expect(document.querySelector("pre")?.textContent).toBe('<script>plain & text</script>');
	expect(document.querySelector("script")).toBeNull();
	expect(fileLanguage("demo.ps1")).toBe("powershell");
	expect(fileLanguage("Demo.java")).toBe("java");
	expect(fileLanguage("query.sql")).toBe("sql");
});
