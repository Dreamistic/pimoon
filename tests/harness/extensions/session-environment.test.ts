import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { captureSessionEnvironment } from "../../../src/harness/session-environment.ts";
import sessionEnvironment from "../../../src/harness/extensions/session-environment.ts";
import { registerExtension } from "../../helpers/extension.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";

const temp = useTempDir("session-environment-");
preserveEnv("GIT_CEILING_DIRECTORIES");
function git(...args: string[]): string {
	return execFileSync("git", ["-C", temp.path, ...args], { encoding: "utf8", windowsHide: true });
}
it("真实仓库采集分支、改动数、最近提交；快照有时间且不复制文件内容", async () => {
	git("init", "-b", "main");
	await writeFile(path.join(temp.path, "tracked.txt"), "private-payload");
	git("add", "tracked.txt");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "测试提交");
	await writeFile(path.join(temp.path, "tracked.txt"), "changed-secret");
	await writeFile(path.join(temp.path, "untracked.txt"), "new-secret");
	const snapshot = await captureSessionEnvironment(temp.path);
	expect(snapshot).toContain("git_branch=main");
	expect(snapshot).toContain("uncommitted=2");
	expect(snapshot).toContain("测试提交");
	expect(snapshot).toMatch(/captured_at=\d{4}-/);
	expect(snapshot).not.toMatch(/private-payload|changed-secret|new-secret/);
});
it("非仓库与空仓库降级，不阻止聊天", async () => {
	process.env.GIT_CEILING_DIRECTORIES = path.dirname(temp.path);
	expect(await captureSessionEnvironment(temp.path)).toContain("git=not_repository");
	git("init", "-b", "main");
	expect(await captureSessionEnvironment(temp.path)).toContain("uncommitted=0");
});
it("同会话只采集一次、上下文不重复；重新打开刷新，不污染系统提示词", async () => {
	git("init", "-b", "main");
	const { handlers } = registerExtension(sessionEnvironment);
	const ctx = { cwd: temp.path }, event = { messages: [] };
	await handlers.get("session_start")?.({}, ctx);
	const first = await handlers.get("context")?.(event, ctx) as { messages: { content: string }[] };
	await writeFile(path.join(temp.path, "new.txt"), "new");
	const second = await handlers.get("context")?.(first, ctx) as { messages: { content: string }[] };
	expect(second.messages).toHaveLength(1);
	expect(second.messages[0]?.content).toContain("uncommitted=0");
	await handlers.get("session_start")?.({}, ctx);
	const refreshed = await handlers.get("context")?.(second, ctx) as { messages: { content: string }[] };
	expect(refreshed.messages).toHaveLength(1);
	expect(refreshed.messages[0]?.content).toContain("uncommitted=1");
	await handlers.get("session_shutdown")?.({}, ctx);
});
