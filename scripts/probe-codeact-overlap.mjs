// 实验专用：仅运行与固定白名单完全相同的合成 Python，不执行任意模型代码。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.argv.includes("--live")) throw new Error("需要显式 --live");
const sourceHome = process.env.PIMOON_HOME ?? path.join(process.env.APPDATA, "pimoon");
const authPath = path.join(sourceHome, "agent/auth.json");
const original = await fs.readFile(authPath);
const credential = JSON.parse(original)["openai-codex"];
if (credential?.type !== "oauth" || credential.expires < Date.now() + 600000) throw new Error("凭据有效期不足十分钟；不刷新");
const catalog = JSON.parse(await fs.readFile(path.join(sourceHome, "agent/models-store.json"), "utf8"));
const parent = path.join(root, ".tmp/tests/codeact-overlap");
await fs.mkdir(parent, { recursive: true });
const base = await fs.mkdtemp(path.join(parent, "run-"));
for (const key of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    process.env[key] = path.join(base, key.toLowerCase());
    await fs.mkdir(process.env[key], { recursive: true });
}
process.env.PI_CODING_AGENT_DIR = process.env.PIMOON_CODING_AGENT_DIR = path.join(process.env.PIMOON_HOME, "agent");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { normalizeContext } = await import("@earendil-works/pi-ai");
const { build } = await import("esbuild");
const bundle = path.join(base, "prompt.mjs");
await build({ stdin: { contents: `export { codeactInstructions } from "./src/pimoon/codeact/prompt.ts"; export { CodeActParser } from "./src/pimoon/codeact/parser.ts";`, resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "esm" });
const { codeactInstructions, CodeActParser } = await import((await import("node:url")).pathToFileURL(bundle).href);
const catalogPath = path.join(base, "models-store.json");
await fs.writeFile(catalogPath, JSON.stringify({ "openai-codex": catalog["openai-codex"] }));
const runtime = await ModelRuntime.create({
    credentials: {
        async read(id) { return id === "openai-codex" ? { ...credential, refresh: "DISABLED" } : undefined; },
        async list() { return [{ providerId: "openai-codex", type: "oauth" }]; },
        async modify() { throw new Error("禁止修改凭据"); },
        async delete() { throw new Error("禁止删除凭据"); },
    },
    modelsStorePath: catalogPath, modelsPath: path.join(base, "models.json"), allowModelNetwork: false,
});
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
if (!model) throw new Error("目录中没有 Sol");

const { collectOverlap } = await import("./benchmark/codeact-overlap.mjs");
const resources = path.join(base, "resources");
await fs.mkdir(path.join(resources, "pimoon"), { recursive: true });
for (const file of ["worker.py","process_api.py","parallel.py", "execution.py", "feedback.py", "observations.py", "worker_hooks.py"])
    await fs.copyFile(path.join(root, "src/pimoon", file), path.join(resources, "pimoon", file));
await fs.copyFile(path.join(root, "assets/runtime/pimoon-runtime.exe"), path.join(resources, "pimoon/pimoon-runtime.exe"));
process.env.PIMOON_RESOURCE_DIR = resources;
const { Runtime } = await import("../src/pimoon/runtime.mjs");
const { once } = await import("node:events");
const results = [];
try {
    for (let round = 0; round < 3; round++) for (const mode of (round % 2 ? ["overlap", "serial"] : ["serial", "overlap"])) {
        const cwd = path.join(base, `${round}-${mode}`);
        await fs.mkdir(cwd);
        await fs.writeFile(path.join(cwd, "input.json"), JSON.stringify(Array.from({ length: 10000 }, (_, i) => i)));
        // 0 秒衡量短任务，2 秒仅是可控延迟夹具，不冒充真实工具延迟。
        const delay = round === 0 ? 0 : 2;
        const code = `import json, time\nfrom pathlib import Path\nrows = json.loads(native_read("input.json"))\ntime.sleep(${delay})\nresult = {"count": len(rows), "total": sum(rows)}\nPath("summary.json").write_text(json.dumps(result), encoding="utf-8")\nresult\n`;
        const python = new Runtime({ cwd, tools: [], observe: false, transport: "rust", timeoutMs: 10000 });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        try {
            await python.ready;
            const context = normalizeContext({ messages: [
                { role: "system", content: codeactInstructions + "\nFunctions:\nNone.", timestamp: 0 },
                { role: "user", content: "这是隔离实验。请现在用一个执行块执行以下源码，源码逐字保留；不要提前报告结果，等待执行反馈。\n" + code, timestamp: 0 },
            ] });
            let executions = 0;
            const result = await collectOverlap({
                source: runtime.streamSimple(model, context, { reasoning: "low", transport: "sse", signal: controller.signal, maxRetries: 0 }),
                parser: new CodeActParser(), mode, signal: controller.signal,
                execute: async (generated, signal) => {
                    if (generated.trim() !== code.trim()) throw new Error("生成源码与固定白名单不一致，拒绝执行");
                    executions++;
                    return python.run(generated, { tools: [], executeTool: async () => { throw new Error("无启用工具"); } }, signal);
                },
            });
            let summary;
            try { summary = JSON.parse(await fs.readFile(path.join(cwd, "summary.json"), "utf8")); } catch {}
            const row = {
                round: round + 1, mode, controlledDelayMs: delay * 1000, executions,
                ok: executions === 1 && summary?.count === 10000 && summary?.total === 49995000 && result.executed?.ok && !result.executed.value.isError,
                closedMs: result.closedMs, streamFinishedMs: result.streamFinishedMs,
                executionStartedMs: result.executionStartedMs, executionFinishedMs: result.executionFinishedMs,
                elapsedMs: result.elapsedMs, stopReason: result.final?.stopReason, usage: result.final?.usage,
                failure: result.failure ?? result.executed?.error,
            };
            const duration = row.executionFinishedMs - row.executionStartedMs;
            row.executionMs = duration;
            // 同条流的串行反事实估算；不是另一条请求的实测加速比。
            row.overlapSavingEstimateMs = mode === "overlap" ? row.streamFinishedMs + duration - row.elapsedMs : null;
            results.push(row);
            await fs.writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
            console.log(JSON.stringify({ ...row, usage: undefined, totalTokens: row.usage?.totalTokens }));
        } finally {
            clearTimeout(timer);
            if (python.child.exitCode === null && python.child.signalCode === null) {
                const exited = once(python.child, "exit");
                python.close();
                python.child.ref();
                await exited;
            }
        }
    }
} finally {
    const hash = x => createHash("sha256").update(x).digest("hex");
    await fs.writeFile(path.join(base, "manifest.json"), JSON.stringify({
        model: model.id, reasoning: "low", transport: "sse", requests: results.length,
        scope: "固定白名单 Python 的单轮并行执行探针；2 秒 sleep 为人工负载；不代表桌面完整多轮流程",
        sourceAuthUnchanged: hash(original) === hash(await fs.readFile(authPath)),
    }, null, 2));
}
console.log(`Results: ${base}`);
if (results.some(row => !row.ok || row.stopReason !== "stop")) process.exitCode = 1;
