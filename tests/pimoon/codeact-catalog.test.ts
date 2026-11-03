import { expect, it } from "vitest";
import { Type } from "typebox";
import { codemodeCatalog } from "../../src/harness/codemode/catalog.ts";
import { codemodeHiddenDeclarations, codemodeSelection } from "../../src/harness/codemode/loadout.ts";

it("目录从参数 schema 生成可区分可选参数和嵌套对象的紧凑签名", () => {
	const parameters = Type.Object({
		path: Type.String({ description: "Workspace path." }),
		mode: Type.Optional(Type.Union([Type.Literal("regex"), Type.Literal("literal")])),
		jobs: Type.Array(Type.Object({ old: Type.String(), new: Type.String(), replace_all: Type.Optional(Type.Boolean({ description: "Replace all matches." })) })),
	});
	const catalog = codemodeCatalog([
		{ name: "read", description: "Read fixture.", parameters },
		{ name: "codemode", description: "Entry.", parameters: Type.Object({}) },
		{ name: "unsupported", description: "Hidden.", parameters: Type.Object({}) },
	]);
	expect(catalog).toContain('read(path: str, mode?: "regex"|"literal", jobs: list[{old: str, new: str, replace_all?: bool}])');
	expect(catalog).toContain("path: Workspace path.");
	expect(catalog).toContain("jobs[].replace_all: Replace all matches.");
	expect(catalog).not.toContain("unsupported");
	expect(catalog).not.toContain('"properties"');
});

it("只隐藏执行声明，不丢失底层能力选择或显式无工具状态", () => {
	expect(codemodeHiddenDeclarations(["codemode", "read", "bash", "other"].map(name => ({ name })))).toEqual(["read", "bash", "other"]);
	expect(codemodeSelection(["read", "bash"])).toEqual(["read", "bash", "codemode"]);
	expect(codemodeSelection(["read", "codemode"])).toEqual(["read", "codemode"]);
	expect(codemodeSelection([])).toEqual([]);
});
