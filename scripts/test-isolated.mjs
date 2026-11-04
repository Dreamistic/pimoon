// 只运行 Node 验证命令；配置与凭据全部落在独立测试目录。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.argv.length < 3) throw new Error("用法: node scripts/test-isolated.mjs <Node 参数或脚本>...");
const base = path.resolve(".tmp/tests/isolated");
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, "case-"));
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
for (const name of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
	const directory = path.join(root, name.toLowerCase());
	fs.mkdirSync(directory); env[name] = directory;
}
env.PI_CODING_AGENT_DIR = env.PIMOON_CODING_AGENT_DIR = path.join(env.PIMOON_HOME, "agent");
const result = spawnSync(process.execPath, process.argv.slice(2), { env, stdio: "inherit", windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
