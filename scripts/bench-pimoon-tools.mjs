// 离线基准：固定模型响应，真实 SDK 调度与文件工具；不启动 Electron 或访问用户配置。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const upstream = process.argv[2];
const directory = path.join(root, ".tmp/tests/tool-benchmark");
await fs.mkdir(directory, { recursive: true });
const base = await fs.mkdtemp(path.join(directory, "run-"));
const resources = path.join(root, "dist/desktop/app/resources");
await fs.access(path.join(resources, "pimoon/pimoon-runtime.exe"));
const cases = upstream ? [["o-pi", path.resolve(upstream)], ["pimoon", root]] : [["pimoon", root]];
const results = [];
for (const [name, source] of cases) {
	const home = path.join(base, name);
	for (const dir of ["home", "appdata", "localappdata", "profile", "temp"]) await fs.mkdir(path.join(home, dir), { recursive: true });
	const bundle = path.join(home, "harness.mjs");
	await build({ stdin: { contents: `export { default as fileTools } from ${JSON.stringify(path.join(source, "src/harness/extensions/file-tools.ts"))};
${name === "pimoon" ? `export { default as codemode } from ${JSON.stringify(path.join(source, "src/harness/extensions/codemode.ts"))};
export { flushTelemetry, telemetryStats } from ${JSON.stringify(path.join(source, "src/pimoon/telemetry.ts"))};` : ""}
export { startModelServer } from ${JSON.stringify(path.join(root, "tests/cli/model-server.ts"))};
export async function disposeLsp() { const { lspManager } = await import(${JSON.stringify(path.join(source, "src/harness/lsp/index.ts"))}); await lspManager.reload(); }`, resolveDir: root }, outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
	const result = spawnSync(process.execPath, [path.join(root, "scripts/workers/bench-pimoon-tools-worker.mjs"), name, bundle, home], {
		cwd: root, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
		env: { ...process.env, HOME: path.join(home, "home"), USERPROFILE: path.join(home, "home"), APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"), TEMP: path.join(home, "temp"), TMP: path.join(home, "temp"), PIMOON_HOME: path.join(home, "profile"), PIMOON_RESOURCE_DIR: resources, PI_OPI_RESOURCE_DIR: resources },
	});
	if (result.status !== 0) throw new Error(`${name}: ${result.error ?? result.stderr}\n${result.stdout}`);
	const data = JSON.parse(result.stdout.trim().split("\n").at(-1));
	results.push(data);
}
await fs.writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
console.log("Offline SDK benchmark; bundled harness + built workers; filesystem warm. First call includes lazy initialization, not desktop startup.");
console.table(results.flatMap(result => result.rows.map(row => ({ app: result.app, ...row }))));
console.table(results.map(({ app, declarations, modelRequests, toolTurns, telemetry, prewarm }) => ({ app, ...declarations, toolTurns, modelRequests, telemetryEnqueueMs: telemetry ? +telemetry.enqueueMs.toFixed(2) : undefined, backgroundIoMs: telemetry ? +telemetry.ioMs.toFixed(2) : undefined, prewarmMs: prewarm ? +prewarm.startupMs.toFixed(2) : undefined, readyBeforeCodeAct: prewarm?.readyBeforeFirstCall })));
console.log("Token counts: generic o200k_base estimates, not provider usage. pimoon also runs 40 CodeAct cases; total requests are not a speed comparison.");
console.log(`Raw samples: ${path.join(base, "results.json")}`);
