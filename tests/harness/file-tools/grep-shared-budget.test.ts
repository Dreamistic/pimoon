import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { GrepScanBudget, FILE_SCAN_CONCURRENCY } from "../../../src/harness/file-tools/grep/scan-budget.ts";
import { deferredVoid } from "../../helpers/async.ts";
import { createGrepTestContext, overrideContent, withGrepRuntime } from "./grep-fixtures.ts";

const fixture = createGrepTestContext();

it("并发真实搜索共享扫描上限，排队查询取消不影响另一查询或后续搜索", async () => {
	const files = FILE_SCAN_CONCURRENCY * 2;
	await Promise.all(Array.from({ length: files }, (_, index) => writeFile(path.join(fixture.workspace, `${index}.txt`), "needle beta\n")));
	await withGrepRuntime(fixture.workspace, "shared-budget", async ({ execute, opened }) => {
		const gate = deferredVoid(), started = deferredVoid();
		let active = 0, peak = 0;
		const filesystem = overrideContent(opened.filesystem, content => ({
			async scanLines(file, options) {
				active++; peak = Math.max(peak, active);
				if (active === FILE_SCAN_CONCURRENCY) started.resolve();
				try { await gate.promise; return await content.scanLines(file, options); }
				finally { active--; }
			},
		}));
		const scheduling = vi.spyOn(GrepScanBudget.prototype, "run");
		const controller = new AbortController();
		const first = execute({ query: "needle" }, { filesystem });
		await started.promise;
		const second = execute({ query: "beta" }, { filesystem, operation: { signal: controller.signal } });
		try {
			await vi.waitFor(() => expect(scheduling.mock.calls.length).toBeGreaterThan(FILE_SCAN_CONCURRENCY));
			controller.abort();
			await expect(second).resolves.toMatchObject({ status: "failed", error: { code: "OPERATION_ABORTED" } });
			expect(peak).toBe(FILE_SCAN_CONCURRENCY);
			gate.resolve();
			await expect(first).resolves.toMatchObject({ status: "success", stats: { searched_files: files } });
			await expect(execute({ query: "beta" }, { filesystem })).resolves.toMatchObject({ status: "success", stats: { searched_files: files } });
			expect(peak).toBeLessThanOrEqual(FILE_SCAN_CONCURRENCY);
		} finally {
			controller.abort(); gate.resolve(); scheduling.mockRestore();
			await Promise.allSettled([first, second]);
		}
	});
});
