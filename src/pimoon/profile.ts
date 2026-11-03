import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { codemodeSelection } from "../harness/codemode/loadout.ts";

/** 应用标识与 SDK 的兼容边界；从不沿用调用者的 .pi 配置。 */
export const pimoonHome = path.resolve(process.env.PIMOON_HOME ?? path.join(process.env.APPDATA ?? os.homedir(), "pimoon"));
export const agentHome = path.join(pimoonHome, "agent");
/** 原生 Python、宿主读取与文件工具共享的凭据保护集合。 */
export const protectedCredentialPaths = [path.join(agentHome, "auth.json"),
	...[".ssh", ".aws", ".azure", ".gnupg", ".kube"].map(name => path.join(os.homedir(), name))];
export const defaultWorkspace = path.resolve(process.env.PIMOON_WORKSPACE ?? path.join(pimoonHome, "workspace"));
for (const folder of [agentHome, defaultWorkspace, path.join(pimoonHome, "desktop"), path.join(pimoonHome, "telemetry")]) fs.mkdirSync(folder, { recursive: true });
process.env.PIMOON_HOME = pimoonHome;
process.env.PIMOON_CODING_AGENT_DIR = agentHome;
process.env.PI_CODING_AGENT_DIR = agentHome;
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PIMOON_OFFLINE = "1";
process.env.PIMOON_TELEMETRY = "0";
const settings = path.join(agentHome, "settings.json");
const defaultTools = ["read", "write", "edit", "find", "grep", "ls", "bash", "websearch", "webfetch", "codemode"];
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({
	defaultProvider: "openai-codex", defaultModel: "gpt-6-astra", defaultThinkingLevel: "low",
	defaultTools,
	enabledModels: ["openai-codex/gpt-6-astra"], transport: "sse",
	cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
	defaultProjectTrust: "never", extensions: [], packages: [],
}, null, 2), { mode: 0o600 });
else {
	// 保留已有能力开关，只为显式执行工具列表补齐 CodeAct；空列表不变。
	const original = fs.readFileSync(settings, "utf8");
	const errors: ParseError[] = [];
	const value: unknown = parse(original, errors, { allowTrailingComma: true });
	if (errors.length === 0 && typeof value === "object" && value !== null && "defaultTools" in value
		&& Array.isArray(value.defaultTools) && value.defaultTools.every((name: unknown): name is string => typeof name === "string")) {
		const selected = codemodeSelection(value.defaultTools);
		if (selected.length !== value.defaultTools.length) fs.writeFileSync(settings, applyEdits(original, modify(original, ["defaultTools"], selected, {})));
	}
}
