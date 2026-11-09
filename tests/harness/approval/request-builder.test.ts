import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApprovalRequest } from "../../../src/harness/approval/pi/request.ts";
import * as webConfig from "../../../src/harness/web-tools/config.ts";
import { defaultWebToolsConfig } from "../web-tools/config-fixture.ts";
const cwd = path.resolve(".tmp/tests/request-builder");
beforeEach(() => vi.spyOn(webConfig, "loadWebToolsConfig").mockResolvedValue(defaultWebToolsConfig()));
afterEach(() => vi.restoreAllMocks());
it("进程保留真实 argv、cwd、环境与继承语义，不再静态拆分或授予长期权限", async () => {
	const input = { argv: ["powershell", "-Command", "echo ready; Remove-Item old"], cwd: "child", env: { MODE: "test" }, inherit_env: false };
	expect(await buildApprovalRequest({ type: "tool_call", toolName: "process_run", toolCallId: "p", input }, cwd)).toMatchObject({
		tool: "process_run", cwd: path.join(cwd, "child"), detail: { argv: input.argv, env: input.env, inherit_env: false },
	});
});
it("Bash 原始复合命令完整交给模型，不使用临时目录豁免或正则拒绝", async () => {
	const command = 'echo ready; rm -rf "$TARGET"';
	const request = await buildApprovalRequest({ type: "tool_call", toolName: "bash", toolCallId: "b", input: { command } }, cwd);
	expect(request).toMatchObject({ tool: "bash", detail: { command } }); expect(request?.units).toHaveLength(1);
});
it.each(["read", "find", "grep", "ls", "websearch", "mcp_send"])("%s 也进入审批", async toolName => {
	expect(await buildApprovalRequest({ type: "tool_call", toolName, toolCallId: "x", input: { query: "fixture" } }, cwd))
		.toMatchObject({ tool: "other", detail: { name: toolName, input: { query: "fixture" } } });
});
it("写入与编辑保留全部正文及删除内容，路径与文件执行层一致", async () => {
	const write = await buildApprovalRequest({ type: "tool_call", toolName: "write", toolCallId: "w", input: { path: "file", content: "new" } }, cwd);
	expect(write).toMatchObject({ detail: { path: path.join(cwd, "file").replace(/\\/g, "/"), content: "new" } });
	const edits = [{ old: "guard()", new: "pass", replace_all: true }];
	expect(await buildApprovalRequest({ type: "tool_call", toolName: "edit", toolCallId: "e", input: { path: "skill://test", edits } }, cwd)).toMatchObject({ detail: { path: "skill://test", edits } });
});
it("公网、内网及下载均交给 AI，网络规则不再决定是否需要 AI 审批", async () => {
	for (const url of ["https://8.8.8.8/query", "http://127.0.0.1/private"]) {
		const request = await buildApprovalRequest({ type: "tool_call", toolName: "http", toolCallId: "h", input: { url, mode: "download", path: "file" } }, cwd);
		expect(request?.units.map(unit => unit.action)).toEqual(["fetch_url", "write_file"]);
	}
});
