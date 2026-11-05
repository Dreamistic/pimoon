// 只读订阅凭据；隔离所有测试写入，不执行模型生成代码。
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
const parent = path.join(root, ".tmp/tests/codeact-natural-stop");
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
await build({ entryPoints: [path.join(root, "src/pimoon/codeact/prompt.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm" });
const { codeactInstructions } = await import((await import("node:url")).pathToFileURL(bundle).href);
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
const marker = "<" + "/execute>";
const oldRule = `${marker} at line start ends it and discards any suffix. Then wait for execute_result.`;
const newRule = `${marker} at line start ends the code block. Immediately end your assistant turn after this marker: no further text, reasoning, or second block. The host executes code only after your turn ends. Wait for execute_result in the next user message; never invent results.`;
if (!codeactInstructions.includes(oldRule)) throw new Error("提示词基线不匹配");
const functions = "\nFunctions:\nread(path: str) -> str: Read one UTF-8 file.\nwrite(path: str, content: str) -> str: Write one previously read file.";
const cases = [
    ["read", "读取 workspace/settings.json，告诉我当前配置。"],
    ["independent", "分别读取 workspace/a.json 和 workspace/b.json，然后比较里面的版本号。"],
    ["dependent", "检查 workspace/settings.json；如果 retry 小于 3 就改成 3，否则不改。完成后告诉我结果。"],
];
const results = [];
try {
    for (let round = 0; round < 2; round++) for (const [scenario, prompt] of cases) {
        for (const variant of (round % 2 ? ["explicit", "baseline"] : ["baseline", "explicit"])) {
            const system = (variant === "baseline" ? codeactInstructions : codeactInstructions.replace(oldRule, newRule)) + functions;
            const context = normalizeContext({ messages: [
                { role: "system", content: system, timestamp: 0 },
                { role: "user", content: prompt, timestamp: 0 },
            ] });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60000);
            const started = performance.now();
            let text = "", closedMs, firstTextMs;
            let final;
            try {
                const source = runtime.streamSimple(model, context, { reasoning: "low", transport: "sse", signal: controller.signal, maxRetries: 0 });
                for await (const event of source) {
                    if (event.type !== "text_delta") continue;
                    firstTextMs ??= performance.now() - started;
                    text += event.delta;
                    if (closedMs === undefined && /(?:^|\n)<\/execute>/.test(text)) closedMs = performance.now() - started;
                }
                final = await source.result();
            } finally { clearTimeout(timer); }
            const end = performance.now() - started;
            const match = /(?:^|\n)<\/execute>/.exec(text);
            const suffix = match ? text.slice(match.index + match[0].length) : undefined;
            const row = {
                round: round + 1, scenario, variant, stopReason: final.stopReason, rawStopReason: final.rawStopReason,
                elapsedMs: Math.round(end), firstTextMs: Math.round(firstTextMs ?? end),
                closedMs: closedMs === undefined ? null : Math.round(closedMs),
                settleMs: closedMs === undefined ? null : Math.round(end - closedMs),
                blocks: (text.match(/(?:^|\n)<execute(?: |>)/g) ?? []).length,
                suffixChars: suffix?.trim().length ?? null,
                usage: final.usage, text,
            };
            results.push(row);
            await fs.writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
            console.log(JSON.stringify({ ...row, text: undefined, usage: undefined, totalTokens: final.usage.totalTokens }));
            if (final.stopReason === "error") break;
        }
    }
} finally {
    const hash = x => createHash("sha256").update(x).digest("hex");
    await fs.writeFile(path.join(base, "manifest.json"), JSON.stringify({
        model: model.id, reasoning: "low", transport: "sse", requests: results.length,
        scope: "独立单轮合成请求；不执行代码；不代表完整桌面会话", sourceAuthUnchanged: hash(original) === hash(await fs.readFile(authPath)),
        baseline: codeactInstructions, explicitRule: newRule,
    }, null, 2));
}
console.log(`Results: ${base}`);
