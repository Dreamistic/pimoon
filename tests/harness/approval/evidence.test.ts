import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { collectApprovalEvidence, collectBlockEvidence } from "../../../src/harness/approval/evidence.ts";
import { useTempDir } from "../../helpers/lifecycle.ts";
const temp = useTempDir("approval-evidence-");
const signal = () => new AbortController().signal;
it("执行脚本提供当前正文和哈希，不把文件名当作无害证明", async () => {
	await writeFile(path.join(temp.path, "check.py"), "print('fixture')");
	const evidence = await collectApprovalEvidence({ tool: "process_run", cwd: temp.path, units: [], detail: { argv: ["python", "check.py"], env: {} } }, signal());
	expect(evidence).toContainEqual(expect.objectContaining({ kind: "script", text: "print('fixture')", sha256: expect.any(String), pinnedForExecution: false }));
});
it("工作区之外的脚本不自动读取，缺失脚本不编造内容", async () => {
	const child = path.join(temp.path, "child"); await mkdir(child); await writeFile(path.join(temp.path, "outside.py"), "private fixture");
	const evidence = await collectApprovalEvidence({ tool: "process_run", cwd: child, units: [], detail: { argv: ["python", "../outside.py", "missing.py"], env: {} } }, signal());
	expect(JSON.stringify(evidence)).not.toContain("private fixture");
	expect(evidence).toContainEqual(expect.objectContaining({ path: "missing.py", available: false }));
});
it("Git 事实绑定实际 -C 目标，脏文件状态不是主模型自述", async () => {
	const child = path.join(temp.path, "repo"); await mkdir(child);
	execFileSync("git", ["init", child], { windowsHide: true, stdio: "pipe" });
	await writeFile(path.join(child, "draft.txt"), "uncommitted");
	const evidence = await collectApprovalEvidence({ tool: "process_run", cwd: temp.path, units: [], detail: { argv: ["git", "-C", "repo", "status"], env: {} } }, signal());
	expect(evidence).toContainEqual(expect.objectContaining({ kind: "gitStatus", target: child, available: true, text: expect.stringContaining("draft.txt") }));
});

it("整段审查同时取得后续确定脚本，不把第一个进程的证据外推", async () => {
	await writeFile(path.join(temp.path, "first.py"), "print('first')");
	await writeFile(path.join(temp.path, "later.py"), "print('later')");
	const request = { tool: "process_run" as const, cwd: temp.path, units: [], detail: { argv: ["python", "first.py"], env: {} } };
	const evidence = await collectBlockEvidence(request, { complete: true, unresolvedLines: [], calls: [{ tool: "process_run", line: 2, input: { argv: ["python", "later.py"] } }] }, temp.path, signal());
	expect(JSON.stringify(evidence)).toContain("print('first')"); expect(JSON.stringify(evidence)).toContain("print('later')");
	expect(evidence).toContainEqual(expect.objectContaining({ kind: "planned_process", line: 2 }));
});
