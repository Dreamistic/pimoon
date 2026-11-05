// 源码搜索基准：真实文件工具，不启动 GUI、LSP 或模型；只读仓库，配置与结果隔离。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runs = Number(process.argv[2] ?? 3);
const concurrent = process.argv.includes("--concurrent");
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("采样次数必须为 1–10。");
const parent = path.join(root, ".tmp/tests/search-benchmark");
await fs.mkdir(parent, { recursive: true });
const base = await fs.mkdtemp(path.join(parent, "run-"));
for (const key of ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
	const directory = path.join(base, key.toLowerCase());
	await fs.mkdir(directory);
	process.env[key] = directory;
}
delete process.env.PIMOON_RESOURCE_DIR;
delete process.env.PI_PACKAGE_DIR;
const config = path.join(base, "file-tools.jsonc");
await fs.writeFile(config, JSON.stringify({ blocked_path: [".git/"], ignored_path: ["node_modules/"], ignore: { builtin_profile: "minimal", gitignore: true }, limits: { grep_max_entries: 10000 } }));
process.env.PI_FILE_TOOLS_CONFIG = config;
const { FileToolsHost } = await import("../src/harness/file-tools/runtime/host.ts");
const { GrepTool } = await import("../src/harness/file-tools/grep/command.ts");
const host = new FileToolsHost(), tool = new GrepTool();
const samples = [];
try {
	for (let index = 0; index < runs; index++) {
		const queries = concurrent ? ["PIMOON_HOME", "enabledModels|selectedModels|scopedModels", "codeact", "approval"] : ["PIMOON_HOME", "enabledModels|selectedModels|scopedModels"];
		const batchStarted = performance.now();
		const search = async query => {
			const started = performance.now();
			const opened = await host.open({ cwd: root, sessionId: "search-benchmark" });
			if (opened.status === "failed") throw new Error(JSON.stringify(opened));
			try {
				const result = await tool.execute({ query, path: [root] }, opened);
				if (result.status === "failed") throw new Error(JSON.stringify(result));
				return { sample: index, query, ms: performance.now() - started, timing: result.timing, stats: result.stats, truncated: result.truncated_by };
			} finally { opened.dispose(); }
		};
		if (concurrent) {
			const results = await Promise.all(queries.map(search));
			const batchMs = performance.now() - batchStarted;
			samples.push(...results.map(result => ({ ...result, batchMs })));
			console.log(`batch=${index} ms=${Math.round(batchMs)}`);
		} else for (const query of queries) samples.push(await search(query));
	}
} finally { tool.dispose(); host.dispose(); }
const output = path.join(base, "results.json");
await fs.writeFile(output, JSON.stringify(samples, null, 2));
console.table(samples.map(({ sample, query, ms, timing, stats, truncated }) => ({
	sample, query, ms: Math.round(ms), inventoryMs: Math.round(timing?.inventory_ms ?? 0), scanMs: Math.round(timing?.scan_ms ?? 0),
	entries: stats.traversed_entries, files: stats.searched_files, hits: stats.text_hits, truncated: truncated.join(","),
})));
console.log("首轮含惰性初始化，后续复用缓存；结果受仓库内容和文件系统缓存影响，不等同桌面端端到端延迟。");
console.log(`结果：${output}`);
