import { parse } from "jsonc-parser";
import { expect, it } from "vitest";
import { migrateToolSettings } from "../../src/pimoon/tool-settings.ts";

it.each([
	'{"defaultTools":["read","process_run"]}',
	'{"defaultTools":["read","read"]}',
	'{"defaultTools":[]}',
	'{"defaultTools":"bash"}',
	'{"defaultTools":["bash",1]}',
	'{"defaultTools":["bash"],',
	'null',
	'[]',
])("不改写有效的新配置或损坏配置: %s", original => {
	expect(migrateToolSettings(original)).toBe(original);
});

it("保留 BOM、注释、其他字段和显式关闭进程的意图", () => {
	const original = '\uFEFF{\n// 用户选择\n"defaultTools":["read","-bash","codemode"],\n"codemode":{"mode":"only"},\n"defaultModel":"custom",\n"enabledModels":["fixture/test"],\n}';
	const migrated = migrateToolSettings(original);
	expect(migrated.startsWith("\uFEFF")).toBe(true);
	expect(migrated).toContain("// 用户选择");
	expect(parse(migrated.slice(1))).toEqual({ defaultTools: ["read", "-process_run"], defaultModel: "custom", enabledModels: ["fixture/test"] });
	expect(migrateToolSettings(migrated)).toBe(migrated);
});
