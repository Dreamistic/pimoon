import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const defaultTools = ["read", "write", "edit", "find", "grep", "ls", "process_run", "http", "websearch", "webfetch"];
if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({
	defaultProvider: "openai-codex", defaultModel: "gpt-6-astra", defaultThinkingLevel: "low",
	defaultTools,
	enabledModels: ["openai-codex/gpt-6-astra"], transport: "sse",
	cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
	defaultProjectTrust: "never", extensions: [], packages: [],
}, null, 2), { mode: 0o600 });
