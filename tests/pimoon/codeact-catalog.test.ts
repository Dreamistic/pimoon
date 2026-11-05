import { expect, it } from "vitest";
import { Type } from "typebox";
import { functionCatalog } from "../../src/pimoon/codeact/catalog.ts";
import { isCodeActFunction } from "../../src/pimoon/codeact/functions.ts";
import { readOutputSchema } from "../../src/harness/file-tools/pi/read-output.ts";
import { nativeInstructions } from "../../src/pimoon/codeact/native-instructions.ts";

it("函数目录来自真实 schema，保留可选参数、嵌套结构和返回类型", () => {
	const catalog = functionCatalog([{ name: "edit", description: "Edit fixture.", parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ old: Type.String(), new: Type.String(), replace_all: Type.Optional(Type.Boolean()) })) }), outputSchema: Type.Object({ changed: Type.Integer() }) }]);
	expect(catalog).toContain("edit(path: str, edits: list[{old: str, new: str, replace_all?: bool}]) -> {changed: int}");
	expect(catalog).not.toContain('"properties"');
});
it("保留字符串最小长度，避免模型把空查询当成枚举接口", () => {
	const catalog = functionCatalog([{ name: "find", description: "Find paths.", parameters: Type.Object({ query: Type.String({ minLength: 1, description: "fzf query." }), glob: Type.Optional(Type.String({ minLength: 1 })), note: Type.Optional(Type.String()) }) }]);
	expect(catalog).toContain("  query: fzf query. minLength=1");
	expect(catalog).toContain("  glob: minLength=1");
	expect(catalog).not.toContain("  note:");
});

it("返回值说明沿用 schema 的联合分支，明确 read 展示文本与原文解析的区别", () => {
	const catalog = functionCatalog([{ name: "read", description: "Read one file.", parameters: Type.Object({ path: Type.String() }), outputSchema: readOutputSchema }]);
	expect(catalog).toContain("  returns str: Rendered <read> view, not raw text; use native_read(path) for JSON/CSV parsing.");
	expect(catalog.match(/Rendered <read> view/gu)).toHaveLength(1);
	expect(nativeInstructions).toContain("Only listed functions are enabled");
	expect(nativeInstructions).toContain("native_read(path)");
	const custom = functionCatalog([{ name: "custom_data", description: "Fixture.", parameters: Type.Object({}),
		outputSchema: Type.Object({ value: Type.Integer() }, { description: "Parsed value, not serialized JSON." }) }]);
	expect(custom).toContain("  returns {value: int}: Parsed value, not serialized JSON.");
});

it("不再硬编码旧工具白名单；插件函数可进入目录，Shell 包装除外", () => {
	expect(isCodeActFunction("custom_function")).toBe(true);
	expect(isCodeActFunction("mcp__demo__read")).toBe(true);
	expect(isCodeActFunction("bash")).toBe(false); expect(isCodeActFunction("powershell")).toBe(false);
	const catalog = functionCatalog([{ name: "custom_function", description: "Fixture", parameters: Type.Object({}) }]);
	expect(catalog).toBe("custom_function() -> str: Fixture");
	for (const name of ["custom-function", "class", "中文函数"]) expect(functionCatalog([{ name, description: "Fixture", parameters: Type.Object({}) }])).toContain(`getattr(functions,${JSON.stringify(name)})()`);
});

it("模型只见标准进程签名，不再学习专用进程和并发 API",()=>{
 const catalog=functionCatalog([{name:"process_run",description:"internal process service",parameters:Type.Object({argv:Type.Array(Type.String())})}]);
 expect(catalog).toContain("subprocess.run(args:");expect(catalog).toContain("CompletedProcess");expect(catalog).not.toContain("process_run");
 expect(nativeInstructions).not.toContain("batch(");expect(nativeInstructions).not.toContain("process_run");
});
