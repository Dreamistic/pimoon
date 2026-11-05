import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error 发布脚本为独立 MJS。
import { applyDesktopUpdate } from "../../scripts/apply-desktop-update.mjs";

async function fixture() {
    const base = path.resolve(".tmp/tests/desktop-update");
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, "case-"));
    const current = path.join(root, "dist/pimoon"), next = path.join(root, "dist/pimoon-native-update");
    await fs.mkdir(current, { recursive: true });
    await fs.writeFile(path.join(current, "sentinel"), "old");
    await fs.mkdir(path.join(next, "resources/app"), { recursive: true });
    for (const file of ["pimoon.exe", "resources/app/backend.mjs", "resources/app/package.json"]) await fs.writeFile(path.join(next,file), "fixture");
    await fs.writeFile(path.join(next,"release.json"), JSON.stringify({ protocol:"native-execute",commit:"c1c15b6",backendSha256:createHash("sha256").update("fixture").digest("hex") }));
    return {root,current,next};
}
it("运行中拒绝更新，两个目录均保持不变", async()=>{
    const f=await fixture();
    await expect(applyDesktopUpdate(f.root,async()=>true)).rejects.toThrow("先退出");
    expect(await fs.readFile(path.join(f.current,"sentinel"),"utf8")).toBe("old");
    await expect(fs.access(f.next)).resolves.toBeUndefined();
});
it("退出后更新保留旧目录，重复启动不再次切换", async()=>{
    const f=await fixture();
    const result=await applyDesktopUpdate(f.root,async()=>false);
    expect(result.updated).toBe(true);
    expect(await fs.readFile(path.join(result.backup,"sentinel"),"utf8")).toBe("old");
    await expect(fs.access(path.join(f.current,"resources/app/backend.mjs"))).resolves.toBeUndefined();
    expect(await applyDesktopUpdate(f.root,async()=>false)).toEqual({updated:false});
});
it("待更新产物缺失时拒绝，不移动当前目录",async()=>{
    const f=await fixture();
    await fs.unlink(path.join(f.next,"resources/app/backend.mjs"));
    await expect(applyDesktopUpdate(f.root,async()=>false)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.current,"sentinel"),"utf8")).toBe("old");
});

it("后端被改动时拒绝更新，旧版不动",async()=>{
    const f=await fixture();
    await fs.writeFile(path.join(f.next,"resources/app/backend.mjs"),"modified");
    await expect(applyDesktopUpdate(f.root,async()=>false)).rejects.toThrow("校验失败");
    expect(await fs.readFile(path.join(f.current,"sentinel"),"utf8")).toBe("old");
});
