// 成品三态审批：合成 OAuth、本地模型服务、独立目录；不启动窗口、不读取真实凭据。
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
const [base, app] = process.argv.slice(2);
const routine = process.argv.includes("--routine");
if (!base || !app) throw new Error("Usage: node scripts/smoke-approval-ai-artifact.mjs TEST_DIR APP_DIR");
await fs.mkdir(base); // 拒绝复用旧副作用目录。
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_SUBAGENT_CHILD: "1", PI_OFFLINE: "1", PIMOON_NO_NOTIFICATIONS: "1" };
for (const key of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    env[key] = path.join(base, key.toLowerCase()); await fs.mkdir(env[key], { recursive: true });
}
const cwd = path.join(base, "workspace"), agent = path.join(env.PIMOON_HOME, "agent");
await fs.mkdir(cwd); await fs.mkdir(path.join(agent, "configs"), { recursive: true });
const operation = name => `subprocess.run(${JSON.stringify(["node", "-e", `require('node:fs').appendFileSync('${name}-marker','once')`])},check=True)`;
const code = `${routine ? 'write(path="routine.ts",content="before")\nread(path="routine.ts")\nwrite(path="routine.ts",content="after")\nsubprocess.run(["git","status","--short"],check=True,capture_output=True,text=True)\n' : ""}${operation("allow")}\nfor name in ["deny","ask"]:\n try:\n  subprocess.run(["node","-e", "require('node:fs').writeFileSync('"+name+"-marker','bad')"],check=True)\n except ToolError:\n  pass\n else:\n  raise AssertionError(name+" unexpectedly executed")\nprint("approval-artifact-complete")`;
let mainRequests = 0; const decisions = [];
const server = createServer(async (req, res) => {
    try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString());
        const review = JSON.stringify(body.instructions ?? "").includes("independent security monitor") || JSON.stringify(body.input?.filter(item => item.role === "system" || item.role === "developer")).includes("independent security monitor");
        let output;
        if (review) {
            const message = body.input.findLast(item => item.role === "user");
            const text = typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("");
            const input = JSON.parse(text);
            const decision = input.action.parameters.includes("deny-marker") ? "deny" : input.action.parameters.includes("ask-marker") ? "ask" : "allow";
            decisions.push(decision);
            output = JSON.stringify({ decision, title: "成品审批", explanation: `合成 ${decision} 判断`, recommendation: decision === "allow" ? "Allow once" : "Deny", recommendationReason: "仅本次", feedbackPlaceholder: "补充要求", actions: [{ choice: "Allow once", label: "执行本次" }, { choice: "Deny", label: "拒绝" }] });
        } else mainRequests++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
        send({ type: "response.created", response: { id: "fixture" } });
        if (!review && mainRequests === 1) {
            const item = { type: "function_call", id: "item", call_id: "fixture-call", name: "execute" };
            const args = JSON.stringify({ code, desc: "隔离审批三态验证" });
            send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
            send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "item", delta: args });
            send({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } });
        } else {
            output ??= "approval fixture complete";
            send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "answer", role: "assistant", content: [] } });
            send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: output });
            send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text: output }] } });
        }
        send({ type: "response.completed", response: { id: "fixture", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14 } } }); res.end();
    } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/v1`;
const preload = path.join(base, "preload.cjs");
await fs.writeFile(preload, `const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=typeof input==="string"?input:input.url??String(input);if(url!=="https://chatgpt.com/backend-api/codex/responses")throw Error("Unexpected network");return original(${JSON.stringify(url)},options);};`);
const token = "synthetic." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64") + ".synthetic";
await fs.writeFile(path.join(agent, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "DISABLED_SYNTHETIC", expires: Date.now() + 3600000, accountId: "synthetic-account" } }));
await fs.writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { "openai-codex": { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
env.PIMOON_APPROVAL_AI_CONFIG = path.join(agent, "configs/approval-ai.jsonc");
await fs.writeFile(env.PIMOON_APPROVAL_AI_CONFIG, JSON.stringify({ model: "openai-codex/test", routine }));
for (const file of ["auto-title", "discord-presence"]) await fs.writeFile(path.join(agent, "configs", file + ".jsonc"), '{"enabled":false}');
try {
    if (routine) await promisify(execFile)("git", ["init", cwd], { windowsHide: true });
    const result = await promisify(execFile)(path.join(app, "pimoon.exe"), ["--require", preload, path.join(app, "resources/app/backend.mjs"), "--provider", "openai-codex", "--model", "test", "--thinking", "off", "--system-prompt", "Isolated fixture; execute once.", "--mode", "json", "-p", "--no-session", "--tools", "process_run,read,write", "Run isolated approval fixture."], { cwd, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    await fs.writeFile(path.join(base, "output.txt"), result.stdout + "\n" + result.stderr);
    if (await fs.readFile(path.join(cwd, "allow-marker"), "utf8") !== "once") throw new Error("allow did not execute exactly once");
    for (const name of ["deny", "ask"]) if (await fs.stat(path.join(cwd, name + "-marker")).then(() => true, () => false)) throw new Error(name + " unexpectedly executed");
    if (mainRequests !== 2 || JSON.stringify(decisions) !== '["allow","deny","ask"]' || !result.stdout.includes("approval-artifact-complete")) throw new Error("classification flow mismatch");
    const categories = [];
    if (routine) {
        if (await fs.readFile(path.join(cwd, "routine.ts"), "utf8") !== "after") throw new Error("routine edit failed");
        for (const dir of await fs.readdir(path.join(env.PIMOON_HOME, "telemetry"))) for (const file of await fs.readdir(path.join(env.PIMOON_HOME, "telemetry", dir))) {
            if (!file.endsWith(".jsonl")) continue;
            const text = await fs.readFile(path.join(env.PIMOON_HOME, "telemetry", dir, file), "utf8");
            for (const line of text.trim().split("\n").filter(Boolean)) { const row = JSON.parse(line); if (row.type === "approval_diagnostic" && row.phase === "routine") categories.push(row.category); }
        }
        if (JSON.stringify(categories) !== '["project_new_file","local_inspection","project_edit","git_inspection"]') throw new Error("routine routing mismatch: " + JSON.stringify(categories));
    }
    const report = { ok: true, routine, categories, mainRequests, decisions, allowSideEffects: 1, denySideEffects: 0, askWithoutUiSideEffects: 0, windowStarted: false, realCredentialsUsed: false };
    await fs.writeFile(path.join(base, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
