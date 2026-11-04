import { expect, it } from "vitest";
import { Type } from "typebox";
import { functionCatalog } from "../../src/pimoon/codeact/catalog.ts";
import { isCodeActFunction } from "../../src/pimoon/codeact/functions.ts";

it("函数目录来自真实 schema，保留可选参数、嵌套结构和返回类型", () => {
	const catalog = functionCatalog([{ name: "edit", description: "Edit fixture.", parameters: Type.Object({ path: Type.String(), edits: Type.Array(Type.Object({ old: Type.String(), new: Type.String(), replace_all: Type.Optional(Type.Boolean()) })) }), outputSchema: Type.Object({ changed: Type.Integer() }) }]);
	expect(catalog).toContain("edit(path: str, edits: list[{old: str, new: str, replace_all?: bool}]) -> {changed: int}");
	expect(catalog).not.toContain('"properties"');
});
it("不再硬编码旧工具白名单；插件函数可进入目录，Shell 包装除外", () => {
	expect(isCodeActFunction("custom_function")).toBe(true);
	expect(isCodeActFunction("mcp__demo__read")).toBe(true);
	expect(isCodeActFunction("bash")).toBe(false); expect(isCodeActFunction("powershell")).toBe(false);
	const catalog = functionCatalog([{ name: "custom_function", description: "Fixture", parameters: Type.Object({}) }]);
	expect(catalog).toBe("custom_function() -> str: Fixture");
	for (const name of ["custom-function", "class", "中文函数"]) expect(functionCatalog([{ name, description: "Fixture", parameters: Type.Object({}) }])).toContain(`getattr(functions,${JSON.stringify(name)})()`);
});
