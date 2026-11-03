import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("单文件产物脱离 node_modules 后可冷启动同步计数", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pimoon-token-counter-"));
	try {
		const source = fileURLToPath(new URL("../../src/harness/token-counter.ts", import.meta.url));
		const entry = path.join(directory, "entry.ts");
		const executable = path.join(directory, process.platform === "win32" ? "counter.exe" : "counter");
		await writeFile(entry, `import { countTextTokens, countTextTokensSync } from ${JSON.stringify(source)};
const modelId = process.argv[2] ?? "gpt-4o";
const text = "Hello world，中文 <|im_start|> <|endoftext|>";
const sync = countTextTokensSync(text, { modelId });
const asyncCount = await countTextTokens(text, { modelId });
if (JSON.stringify(sync) !== JSON.stringify(asyncCount)) throw new Error("sync/async mismatch");
console.log(JSON.stringify(sync));
`);
		const build = spawnSync(process.env.BUN_BINARY ?? "bun", ["build", entry, "--compile", "--minify", "--bytecode", "--format=esm", "--outfile", executable], {
			encoding: "utf8", windowsHide: true, timeout: 30_000,
		});
		expect(build.error).toBeUndefined();
		expect(build.status, build.stderr).toBe(0);
		const environment = { ...process.env };
		delete environment["BUN_BE_BUN"];
		delete environment["NODE_PATH"];
		for (const [model, method] of [["gpt-4o", "o200k_base"], ["gpt-4", "cl100k_base"], ["gpt-oss-20b", "o200k_harmony"]] as const) {
			// 每次启动独立进程，先走同步计数，不能由异步加载暖缓存掩盖漏打包。
			const result = spawnSync(executable, [model], {
				cwd: directory, env: environment, encoding: "utf8", windowsHide: true, timeout: 15_000,
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({ method, tokens: expect.any(Number) });
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
