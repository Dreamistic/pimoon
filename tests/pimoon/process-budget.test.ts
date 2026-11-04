import { expect, it } from "vitest";
import { limitProcessTimeout } from "../../src/pimoon/codeact/process-budget.ts";

it("按剩余预算裁剪显式与默认超时，预留五秒清理时间", () => {
	expect(limitProcessTimeout({ argv: ["node"], timeout: 200 }, 45_000)).toEqual({ argv: ["node"], timeout: 40 });
	expect(limitProcessTimeout({ argv: ["node"] }, 45_000)).toEqual({ argv: ["node"], timeout: 40 });
	const input = { argv: ["node"], timeout: 10 };
	expect(limitProcessTimeout(input, 45_000)).toBe(input);
	expect(() => limitProcessTimeout(input, 5000)).toThrow("new block");
});
it.each([null, [], { timeout: null }, { timeout: 0 }, { timeout: -1 }, { timeout: 1801 }, { timeout: "30" }, { timeout: Number.NaN }])("无效参数不通过预算裁剪绕过 schema：%j", input => {
	expect(limitProcessTimeout(input, 45_000)).toBe(input);
});
