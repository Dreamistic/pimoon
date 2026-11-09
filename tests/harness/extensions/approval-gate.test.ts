import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadApprovalGateConfig } from "../../../src/harness/approval/config.ts";
import { buildApprovalContent } from "../../../src/harness/approval/presentation.ts";
import { preserveEnv, useTempDir } from "../../helpers/lifecycle.ts";
const temp = useTempDir("approval-config-");
preserveEnv("PIMOON_APPROVAL_AI_CONFIG", "PI_APPROVAL_GATE_CONFIG");
it("新配置默认使用 Codex 订阅 GPT，不读取旧规则配置", async () => {
	process.env.PI_APPROVAL_GATE_CONFIG = path.join(temp.path, "old.jsonc");
	await writeFile(process.env.PI_APPROVAL_GATE_CONFIG, '{"deny_rules":[{"name":"old"}]}');
	process.env.PIMOON_APPROVAL_AI_CONFIG = path.join(temp.path, "new.jsonc");
	const config = await loadApprovalGateConfig();
	expect(config).toMatchObject({ enabled: true, model: "openai-codex/gpt-6.1-sol", timeout_ms: 60000 });
	await writeFile(process.env.PIMOON_APPROVAL_AI_CONFIG, '{"deny_rules":[]}');
	await expect(loadApprovalGateConfig()).rejects.toThrow();
});
it("人工卡片显示真实编辑的删除和新增内容，清除终端控制码", () => {
	const lines = buildApprovalContent({ tool: "edit", cwd: "fixture", units: [], detail: { path: "file", edits: [{ old: "check_auth()", new: "pass\u001b[2J" }] } }, { kind: "ask", reason: "AI review", items: [] });
	const text = lines.map(line => line.text).join("\n");
	expect(text).toContain("check_auth()"); expect(text).toContain("pass"); expect(text).not.toContain("\u001b");
});
