import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCompactGrepResult } from "../../../src/harness/file-tools/grep/command.ts";
import { grepTelemetry } from "../../../src/harness/file-tools/telemetry/grep.ts";
import { safeProject } from "../../../src/harness/telemetry/projection.ts";
import { grepWorkspaceFiles } from "../../helpers/grep-tool.ts";
import { createGrepTestContext, expectGrepSuccess } from "./grep-fixtures.ts";

const context = createGrepTestContext();
describe("搜索阶段计时", () => {
	it("成功、零命中搜索记录顺序阶段，不进入模型正文或挤掉排序字段", async () => {
		await writeFile(path.join(context.workspace, "fixture.ts"), "export const needle = 42;\n");
		for (const query of ["needle", "nothingHere"]) {
			const params = { query };
			const result = expectGrepSuccess(await grepWorkspaceFiles(context.workspace, params));
			const timing = result.timing;
			if (timing === undefined) throw new Error("缺少阶段计时");
			const { total_ms, ...stages } = timing;
			expect(Object.values(stages).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
			expect(Object.values(stages).reduce((a, b) => a + b, 0)).toBeCloseTo(total_ms, 6);
			const projected = safeProject(() => grepTelemetry.result(params, result));
			expect(projected.limited).toBe(false);
			expect(projected.facts.fields).toMatchObject({ inventory_ms: timing.inventory_ms, search_total_ms: total_ms, ranking_selected_file_count: result.ranking?.selected_file_count });
			expect(formatCompactGrepResult(result)).not.toMatch(/inventory_ms|scan_ms|total_ms/);
		}
	});
});
