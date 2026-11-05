// 便携目录更新只在旧应用退出后进行；不删除旧版本，不启动窗口。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

export async function applyDesktopUpdate(root, isRunning) {
    const dist = path.join(root, "dist"), next = path.join(dist, "pimoon-native-update"), current = path.join(dist, "pimoon");
    try { await fs.access(next); } catch (error) { if (error.code === "ENOENT") return { updated: false }; throw error; }
    // 不猜测某个 PID 的用途；仍有 pimoon 进程时禁止切换目录。
    if (await isRunning()) throw new Error("请先退出所有 pimoon 窗口，再重新启动完成更新；当前版本未改动。");
    for (const file of ["pimoon.exe", "resources/app/backend.mjs", "resources/app/package.json", "release.json"])
        await fs.access(path.join(next, file));
    const manifest = JSON.parse(await fs.readFile(path.join(next, "release.json"), "utf8"));
    if (manifest.protocol !== "native-execute" || typeof manifest.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(manifest.commit))
        throw new Error("待更新产物标识无效，未切换。");
    const backendHash = createHash("sha256").update(await fs.readFile(path.join(next, "resources/app/backend.mjs"))).digest("hex");
    if (backendHash !== manifest.backendSha256) throw new Error("待更新后端校验失败，未切换。");
    const backup = path.join(dist, `pimoon-backup-${Date.now()}`);
    // 即使启动检查后出现文件占用，rename 失败也会保留或恢复旧目录。
    await fs.rename(current, backup);
    try { await fs.rename(next, current); }
    catch (error) {
        await fs.rename(backup, current);
        throw error;
    }
    return { updated: true, backup, commit: manifest.commit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const root = fileURLToPath(new URL("../", import.meta.url));
        const result = await applyDesktopUpdate(root, async () => {
            const { stdout } = await promisify(execFile)("tasklist", ["/FI", "IMAGENAME eq pimoon.exe", "/FO", "CSV", "/NH"], { windowsHide: true });
            return /"pimoon\.exe"/i.test(stdout);
        });
        if (result.updated) console.log(`pimoon 已更新至 ${result.commit}，旧版保留于 ${result.backup}。旧文本会话请新建后继续。`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
