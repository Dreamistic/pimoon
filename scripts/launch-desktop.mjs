// 启动错误必须留在控制台，不把更新失败伪装成启动成功。
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyDesktopUpdate } from "./apply-desktop-update.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
try {
    const execute = promisify(execFile);
    await applyDesktopUpdate(root, async () => {
        const { stdout } = await execute("tasklist", ["/FI", "IMAGENAME eq pimoon.exe", "/FO", "CSV", "/NH"], { windowsHide: true });
        return /"pimoon\.exe"/i.test(stdout);
    });
    const executable = path.join(root, "dist/pimoon/pimoon.exe");
    await fs.access(executable);
    await execute("python", ["--version"], { windowsHide: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.PIMOON_HEADLESS;
    const child = spawn(executable, [], { cwd: root, env, detached: true, stdio: "ignore", windowsHide: false });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
