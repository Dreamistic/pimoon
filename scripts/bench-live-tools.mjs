// 显式 --live 才使用订阅；父进程只读凭据，经 stdin 传入隔离子进程，不落盘。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { scenarios } from "./benchmark/tool-scenarios.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const value = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const help = "node scripts/bench-live-tools.mjs --live [--apps=o-pi,pimoon] [--upstream=PATH] [--model=gpt-6.1-terra] [--thinking=low] [--transport=sse|auto] [--prompt=runtime|sdk] [--runs=1] [--scenarios=locate-edit,aggregate,conditional-edit]";
if (args.includes("--help")) { console.log(help); process.exit(0); }
if (!args.includes("--live")) throw new Error(`真实订阅测试需显式 --live；${help}`);
const upstream = value("upstream");
const apps = value("apps", "o-pi,pimoon").split(",");
if (apps.some(app => !["o-pi", "pimoon"].includes(app)) || new Set(apps).size !== apps.length) throw new Error("apps 必须为 o-pi,pimoon 的非重复子集");
if (apps.includes("o-pi") && !upstream) throw new Error("请指定 --upstream=o-pi源码目录");
const thinkingLevel = value("thinking", "low");
if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) throw new Error("无效 thinking");
const transport = value("transport", "sse");
if (!["sse", "auto"].includes(transport)) throw new Error("transport 必须为 sse 或 auto");
const promptMode = value("prompt", "runtime");
if (!["runtime", "sdk"].includes(promptMode)) throw new Error("prompt 必须为 runtime 或 sdk");
const model = value("model", "gpt-6.1-terra");
const runs = Number(value("runs", "1"));
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error("runs 必须为 1..5");
const selected = value("scenarios", Object.keys(scenarios).join(",")).split(",");
if (selected.some(name => !Object.hasOwn(scenarios, name))) throw new Error("未知场景");
const sourceHome = process.env.PIMOON_HOME ?? path.join(process.env.APPDATA, "pimoon");
const authPath = path.join(sourceHome, "agent/auth.json");
const original = await fs.readFile(authPath);
const fingerprint = data => createHash("sha256").update(data).digest("hex");
const credential = JSON.parse(original)["openai-codex"];
if (credential?.type !== "oauth" || credential.expires < Date.now() + 600_000) throw new Error("pimoon 访问凭据不足十分钟；不刷新、不回落其他配置");
const accessOnly = Object.fromEntries(["type", "access", "expires", "accountId"].map(key => [key, credential[key]]));
accessOnly.refresh = "DISABLED_IN_LIVE_BENCHMARK";
const catalog = JSON.parse(await fs.readFile(path.join(sourceHome, "agent/models-store.json"), "utf8"));
const directory = path.join(root, ".tmp/tests/live-tools");
await fs.mkdir(directory, { recursive: true });
const base = await fs.mkdtemp(path.join(directory, "run-"));
const resources = path.join(base, "resources");
await fs.cp(path.join(root, "dist/desktop/app/resources"), resources, { recursive: true });
// Python 源码与被测工作树一致；不覆盖已有桌面构建。
for (const name of ["worker.py", "execution.py", "feedback.py", "observations.py", "worker_hooks.py"]) await fs.copyFile(path.join(root, "src/pimoon", name), path.join(resources, "pimoon", name));
const bundles = {};
const manifest = { createdAt: new Date().toISOString(), model, thinkingLevel, transport, promptMode, apps, runs, scenarios: selected, upstream: upstream ? path.resolve(upstream) : undefined,
	measurement: { schema: 2, tokenizer: "o200k_base", toolTime: "union of root execution intervals", tokenScope: "visible request payload and generated output; hidden reasoning/images excluded; provider usage separate" },
	sources: {}, sourceAuthUnchanged: null };
for (const app of apps) {
	const source = app === "pimoon" ? root : path.resolve(upstream);
	const bundle = path.join(base, `${app}.mjs`);
	const built = await build({ metafile: true, stdin: { contents: `export { default as fileTools } from ${JSON.stringify(path.join(source, "src/harness/extensions/file-tools.ts"))};
export { default as systemPrompt } from ${JSON.stringify(path.join(source, "src/harness/extensions/system-prompt.ts"))};
export { estimateRequestTokens, estimateResponseTokens, summarizeTokenAccounting, textTokens } from ${JSON.stringify(path.join(root, "src/pimoon/token-accounting.ts"))};
export { responseUsageStatus } from ${JSON.stringify(path.join(root, "src/pimoon/usage-status.ts"))};
${app === "pimoon" ? `export { CodeAct } from ${JSON.stringify(path.join(root, "src/pimoon/codeact/session.ts"))}; export { flushTelemetry } from ${JSON.stringify(path.join(root, "src/pimoon/telemetry.ts"))};` : ""}
export async function disposeLsp() { const { lspManager } = await import(${JSON.stringify(path.join(source, "src/harness/lsp/index.ts"))}); await lspManager.reload(); }`, resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
	bundles[app] = bundle;
	manifest.sources[app] = {};
	for (const file of Object.keys(built.metafile.inputs)) if (file !== "<stdin>") manifest.sources[app][file] = fingerprint(await fs.readFile(path.resolve(root, file)));
}
await fs.writeFile(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
const results = [];
try {
	for (let round = 0; round < runs; round++) for (const scenario of selected) {
		const order = (round + selected.indexOf(scenario)) % 2 ? ["pimoon", "o-pi"] : ["o-pi", "pimoon"];
		for (const app of order.filter(app => apps.includes(app))) {
			const home = path.join(base, `${round}-${scenario}-${app}`);
			const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PIMOON_RESOURCE_DIR: resources, PI_OPI_RESOURCE_DIR: resources };
			for (const key of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
				env[key] = path.join(home, key.toLowerCase()); await fs.mkdir(env[key], { recursive: true });
			}
			env.PI_CODING_AGENT_DIR = env.PIMOON_CODING_AGENT_DIR = path.join(env.PIMOON_HOME, "agent");
			const payload = JSON.stringify({ credential: accessOnly, catalog: { "openai-codex": catalog["openai-codex"] } });
			console.log(`Running ${app} ${scenario} round=${round + 1} model=${model} thinking=${thinkingLevel} transport=${transport} prompt=${promptMode}`);
			const result = await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [path.join(root, "scripts/workers/bench-live-tools-worker.mjs"), app, bundles[app], home, scenario, model, thinkingLevel, transport, promptMode], { cwd: root, env, windowsHide: true, timeout: 240_000, stdio: ["pipe", "pipe", "pipe"] });
				let stdout = "", stderr = "";
				child.stdout.on("data", data => { stdout += data; });
				child.stderr.on("data", data => { stderr = (stderr + data).slice(-8000); });
				child.on("error", reject);
				child.on("close", code => {
					if (code !== 0) return reject(new Error(`测试进程失败 ${app}: ${stderr}\n${stdout}`));
					try { resolve(JSON.parse(stdout.trim().split("\n").at(-1))); } catch (error) { reject(error); }
				});
				child.stdin.on("error", reject);
				child.stdin.end(payload);
			});
			results.push({ round: round + 1, ...result });
			await fs.writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
			const { events: _events, requestSizes: _sizes, requestTraces: _traces, ...summary } = results.at(-1);
			console.log(JSON.stringify(summary));
		}
	}
} finally {
	manifest.sourceAuthUnchanged = fingerprint(await fs.readFile(authPath)) === fingerprint(original);
	await fs.writeFile(path.join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
	if (!manifest.sourceAuthUnchanged) console.error("注意：测试期间源凭据发生变化；本测试不写源凭据。");
}
console.table(results.map(({ app, scenario, ok, requests, elapsedMs, toolMs, tokenAccounting }) => ({ app, scenario, ok, requests,
	seconds: +(elapsedMs / 1000).toFixed(2), toolSeconds: +(toolMs / 1000).toFixed(3),
	providerTokens: tokenAccounting.provider_total_tokens ?? "unknown",
	estimatedVisibleTokens: tokenAccounting.estimate.visible_total_tokens, estimatedToolTokens: tokenAccounting.estimate.tool_tokens })));
console.log(`Results: ${path.join(base, "results.json")}`);
if (results.some(result => !result.ok)) process.exitCode = 1;
