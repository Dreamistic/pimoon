import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

/** 应用标识与 SDK 的兼容边界；从不沿用调用者的 .pi 配置。 */
export const pimoonHome = path.resolve(process.env.PIMOON_HOME ?? path.join(process.env.APPDATA ?? os.homedir(), "pimoon"));
export const agentHome = path.join(pimoonHome, "agent");
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
	enabledModels: ["openai-codex/gpt-6-astra"], codemode: { mode: "only" }, transport: "sse",
	cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
	defaultProjectTrust: "never", extensions: [], packages: [],
}, null, 2), { mode: 0o600 });
else {
	// 仅为旧版原始默认列表补充宿主工具，保留用户自定义选择及其他配置。
	const original = fs.readFileSync(settings, "utf8");
	const errors: ParseError[] = [];
	const value: unknown = parse(original, errors, { allowTrailingComma: true });
	if (errors.length === 0 && typeof value === "object" && value !== null && "defaultTools" in value
		&& JSON.stringify(value.defaultTools) === JSON.stringify(defaultTools.filter(name => !["bash", "websearch", "webfetch"].includes(name)))) {
		fs.writeFileSync(settings, applyEdits(original, modify(original, ["defaultTools"], defaultTools, {})));
	}
}
