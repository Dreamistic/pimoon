import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { FileToolsHost } from "../../../src/harness/file-tools/runtime/host.ts";
import { writeFile as writeCommand } from "../../../src/harness/file-tools/write/command.ts";
import { readWorkspaceFile } from "../../helpers/read-tool.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("pimoon-memory-concurrent-");
it("不同会话宿主的覆盖提交共享队列，后写者不能覆盖已变化的版本", async () => {
	const cwd = path.join(temp.path, "workspace"), file = path.join(temp.path, "memory.md"); await mkdir(cwd);
	await writeFile(file, "original");
	const a = new FileToolsHost(), b = new FileToolsHost();
	try {
		await readWorkspaceFile(cwd, { path: file }, { host: a, sessionId: "a" });
		await readWorkspaceFile(cwd, { path: file }, { host: b, sessionId: "b" });
		const openedA = await a.open({ cwd, sessionId: "a" }), openedB = await b.open({ cwd, sessionId: "b" });
		if ("status" in openedA || "status" in openedB) throw new Error("fixture open failed");
		const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
		try {
			const first = writeCommand({ path: file, content: "first" }, { ...openedA, diff: async (before, after) => {
				entered.resolve(); await release.promise; return generateDiffString(before, after);
			} });
			await entered.promise;
			const second = writeCommand({ path: file, content: "second" }, { ...openedB, diff: generateDiffString });
			release.resolve();
			expect(await first).toMatchObject({ status: "written" });
			expect(await second).toMatchObject({ status: "failed", error: { code: "STALE_READ" } });
			expect(await readFile(file, "utf8")).toBe("first");
		} finally { release.resolve(); openedA.dispose(); openedB.dispose(); }
	} finally { a.dispose(); b.dispose(); }
});
