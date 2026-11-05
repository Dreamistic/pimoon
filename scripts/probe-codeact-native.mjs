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
const parent = path.join(root, ".tmp/tests/codeact-native");
await fs.mkdir(parent, { recursive: true });
const base = await fs.mkdtemp(path.join(parent, "run-"));
for (const key of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    process.env[key] = path.join(base, key.toLowerCase());
    await fs.mkdir(process.env[key], { recursive: true });
}
process.env.PI_CODING_AGENT_DIR = process.env.PIMOON_CODING_AGENT_DIR = path.join(process.env.PIMOON_HOME, "agent");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { normalizeContext } = await import("@earendil-works/pi-ai");
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
const catalogModel = runtime.getModel("openai-codex", "gpt-6.1-sol");
if (!catalogModel) throw new Error("目录中没有 Sol");

const resources = path.join(base, "resources");
await fs.mkdir(path.join(resources, "pimoon"), { recursive: true });
for (const file of ["worker.py","process_api.py","auto_parallel.py", "execution.py", "feedback.py", "observations.py", "worker_hooks.py"])
    await fs.copyFile(path.join(root, "src/pimoon", file), path.join(resources, "pimoon", file));
await fs.copyFile(path.join(root, "assets/runtime/pimoon-runtime.exe"), path.join(resources, "pimoon/pimoon-runtime.exe"));
process.env.PIMOON_RESOURCE_DIR = resources;
const { Runtime } = await import("../src/pimoon/runtime.mjs");
const { once } = await import("node:events");

// grammar 能力只在实验模型副本启用，实际请求类型必须被 onPayload 验证。
const results = [];
const code = 'import json\nfrom pathlib import Path\nresult = {"total": sum(json.loads(native_read("input.json")))}\nPath("summary.json").write_text(json.dumps(result), encoding="utf-8")\nresult\n';
try {
    for (let round = 0; round < 3; round++) for (const mode of (round % 2 ? ["json", "custom"] : ["custom", "json"])) {
        const model = { ...catalogModel, compat: { ...catalogModel.compat, supportsOpenAIGrammarTools: mode === "custom" } };
        const tool = {
            name: "execute", description: "Execute Python once, then wait for its result.",
            parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
            constrainedSampling: mode === "custom"
                ? { type: "grammar", variants: { openai_regex: "[\\s\\S]+" } }
                : { type: "json_schema", strict: "require" },
        };
        const cwd = path.join(base, `${round}-${mode}`);
        await fs.mkdir(cwd);
        await fs.writeFile(path.join(cwd, "input.json"), "[20,22]");
        const python = new Runtime({ cwd, tools: [], observe: false, transport: "rust", timeoutMs: 10000 });
        let executions = 0;
        const row = { round: round + 1, mode, turns: [] };
        try {
            await python.ready;
            const context = normalizeContext({
                systemPrompt: "Use execute for Python. Call it once, without a preamble. Wait for the tool result before reporting success. Do not use XML execution blocks. No other functions are available.",
                tools: [tool],
                messages: [{ role: "user", content: "执行下面固定源码，逐字保留。完成后告诉我 total，不要再次执行。\n" + code, timestamp: 0 }],
            });
            for (let turn = 0; turn < 2; turn++) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 45000);
                const started = performance.now();
                let lastArgumentMs, payloadType, final;
                try {
                    const stream = runtime.streamSimple(model, context, {
                        reasoning: "low", transport: "sse", signal: controller.signal, maxRetries: 0,
                        onPayload(payload) {
                            const declared = [...(payload.tools ?? []), ...(payload.input ?? []).flatMap(item => item.tools ?? [])].find(item => item.name === "execute");
                            payloadType = declared?.type;
                            if (payloadType !== (mode === "custom" ? "custom" : "function")) throw new Error(`实际工具类型不匹配: ${payloadType ?? "absent"}`);
                        },
                    });
                    for await (const event of stream) {
                        if (event.type === "toolcall_delta" || event.type === "toolcall_end") lastArgumentMs = performance.now() - started;
                    }
                    final = await stream.result();
                } finally { clearTimeout(timer); }
                const elapsedMs = performance.now() - started;
                const calls = final.content.filter(part => part.type === "toolCall");
                row.turns.push({
                    turn, payloadType, elapsedMs, lastArgumentMs, settleMs: lastArgumentMs === undefined ? null : elapsedMs - lastArgumentMs,
                    stopReason: final.stopReason, rawStopReason: final.rawStopReason, usage: final.usage,
                    calls: calls.length, error: final.errorMessage,
                    text: final.content.filter(part => part.type === "text").map(part => part.text).join(""),
                });
                context.messages.push(final);
                if (turn === 0) {
                    if (final.stopReason !== "toolUse" || calls.length !== 1 || calls[0].name !== "execute" || calls[0].arguments.code?.trim() !== code.trim())
                        throw new Error("原生调用或源码不符合固定白名单，未执行");
                    executions++;
                    const executed = await python.run(code, { tools: [], executeTool: async () => { throw new Error("无工具"); } });
                    if (executed.isError) throw new Error("Python 执行失败");
                    const summary = JSON.parse(await fs.readFile(path.join(cwd, "summary.json"), "utf8"));
                    if (summary.total !== 42) throw new Error("结果错误");
                    context.messages.push({ role: "toolResult", toolCallId: calls[0].id, toolName: "execute",
                        content: executed.content, isError: false, timestamp: Date.now() });
                } else if (final.stopReason !== "stop" || calls.length || !row.turns[1].text.includes("42"))
                    throw new Error("结果回填后的回复不正确");
            }
            row.ok = true;
        } catch (error) { row.ok = false; row.failure = String(error); }
        finally {
            row.executions = executions;
            results.push(row);
            await fs.writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
            console.log(JSON.stringify({ ...row, turns: row.turns.map(({ usage, ...turn }) => ({ ...turn, totalTokens: usage.totalTokens })) }));
            if (python.child.exitCode === null && python.child.signalCode === null) {
                const exited = once(python.child, "exit"); python.close(); python.child.ref(); await exited;
            }
        }
    }
} finally {
    const hash = x => createHash("sha256").update(x).digest("hex");
    await fs.writeFile(path.join(base, "manifest.json"), JSON.stringify({
        model: catalogModel.id, reasoning: "low", transport: "sse",
        catalogGrammarSupport: catalogModel.compat?.supportsOpenAIGrammarTools ?? false,
        scope: "隔离固定源码，原生调用、Python执行、真实工具结果回填；非完整桌面流程",
        sourceAuthUnchanged: hash(original) === hash(await fs.readFile(authPath)),
    }, null, 2));
}
console.log(`Results: ${base}`);
if (results.some(row => !row.ok)) process.exitCode = 1;
