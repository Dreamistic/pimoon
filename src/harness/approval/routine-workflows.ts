import { readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import which from "which";
import type { ApprovalRequest } from "./types.ts";
import { routinePath, within } from "./routine-paths.ts";

const HOMES = ["PIMOON_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
const ENV_KEYS = new Set([...HOMES, "TEMP", "TMP", "CI", "NO_COLOR", "FORCE_COLOR"]);

/** 仅识别直接安装的验证 CLI，绝不展开 npm scripts 或把名字含 test 的脚本当作安全证明。 */
export async function routineWorkflow(request: ApprovalRequest, workspace: string): Promise<string | undefined> {
	if (request.tool !== "process_run" || !await routinePath(workspace, request.cwd)) return;
	const [program, entry, ...args] = request.detail.argv;
	if (!program || !entry || path.basename(program).toLowerCase().replace(/\.exe$/u, "") !== "node") return;
	try {
		// 不接受工作区伪装的 node、Node 启动选项或调用方替换 PATH。
		const installedNode = await which("node");
		const supplied = /[\\/]/u.test(program) ? path.resolve(request.cwd, program) : await which(program);
		if (await realpath(installedNode) !== await realpath(supplied)) return;
		const rel = path.relative(request.cwd, path.resolve(request.cwd, entry)).replaceAll("\\", "/");
		const tool = rel === "node_modules/typescript/bin/tsc" ? "typescript"
			: rel === "node_modules/vitest/vitest.mjs" ? "vitest"
			: rel === "node_modules/vite/bin/vite.js" ? "vite" : undefined;
		if (!tool) return;
		const manifest: unknown = JSON.parse(await readFile(path.join(request.cwd, "node_modules", tool, "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("name" in manifest) || manifest.name !== tool) return;
		const env = request.detail.env;
		if (Object.keys(env).some(key => !ENV_KEYS.has(key))) return;
		if (request.detail.inherit_env !== false && Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|DYLD_.*)$/iu.test(key))) return;
		if (tool === "typescript") {
			if (JSON.stringify(args) !== JSON.stringify(["--noEmit"])
				&& JSON.stringify(args) !== JSON.stringify(["--noEmit", "--pretty", "false"])) return;
			return "local_typecheck";
		}
		// 会执行项目代码的验证任务必须替换继承环境，五个 home 均限定在工作区 .tmp/tests。
		if (request.detail.inherit_env !== false) return;
		const isolated = path.join(request.cwd, ".tmp", "tests");
		for (const key of HOMES) {
			const value = env[key];
			if (!value || !path.isAbsolute(value) || !within(isolated, value) || !await routinePath(workspace, value)) return;
		}
		for (const key of ["TEMP", "TMP"]) if (env[key] && (!path.isAbsolute(env[key]) || !within(isolated, env[key]) || !await routinePath(workspace, env[key]))) return;
		if (tool === "vitest") {
			if (args[0] !== "run") return;
			for (const arg of args.slice(1)) {
				if (["--passWithNoTests", "--no-file-parallelism"].includes(arg)) continue;
				if (arg.startsWith("-") || !/\.test\.[cm]?[jt]sx?$/u.test(arg) || !await routinePath(workspace, path.resolve(request.cwd, arg))) return;
			}
			return "isolated_tests";
		}
		// 构建仅接受标准 build，不接受 server/preview、任意 --config、--outDir 或插件启动参数。
		if (tool === "vite" && args.length === 1 && args[0] === "build") {
			const entries = await readdir(request.cwd);
			// 自定义配置可执行任意代码、改 outDir 或发布；不能仅凭 build 名称免审。
			if (entries.some(name => /^vite\.config\./u.test(name))) return;
			if (!await routinePath(workspace, path.join(request.cwd, "dist"), true)) return;
			return "isolated_build";
		}
	} catch { return; }
}
