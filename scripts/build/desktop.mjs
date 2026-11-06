import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssets } from "./assets.mjs";
import { runtimePlugin } from "./plugins.mjs";

export async function buildDesktop({ root, ui, platform, output, directoryOnly }) {
	if (platform.os !== "win32" || platform.arch !== "x64") throw new Error("pimoon 当前仅提供 Windows x64 原生执行器。");
	const appDir = path.join(output, "app");
	await rm(output, { recursive: true, force: true });
	await mkdir(appDir, { recursive: true });
	await collectAssets(root, path.join(appDir, "resources"), { target: "node", platform });
	const workerDir = path.join(appDir, "resources", "pimoon");
	await mkdir(workerDir, { recursive: true });
	for (const file of ["worker.py","process_api.py", "parallel.py", "execution.py", "feedback.py", "observations.py", "worker_hooks.py"]) await cp(path.join(root, "src/pimoon", file), path.join(workerDir, file));
	await cp(path.join(root, "assets/runtime/pimoon-runtime.exe"), path.join(workerDir, "pimoon-runtime.exe"));
	const sdkPackageFile = path.join(appDir, "resources/pi/package.json");
	const sdkPackage = JSON.parse(await readFile(sdkPackageFile, "utf8"));
	sdkPackage.piConfig = { ...sdkPackage.piConfig, name: "pimoon", configDir: ".pimoon" };
	await writeFile(sdkPackageFile, JSON.stringify(sdkPackage, null, 2));
	const piRoot = new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent"));
	const backendEntry = path.join(output, "backend-entry.ts");
	await writeFile(backendEntry, `import { fileURLToPath } from "node:url";
import ${JSON.stringify(path.join(root, "src/desktop/environment.ts"))};
const { setEmbeddedQuickJSWasmPath } = await import(${JSON.stringify(fileURLToPath(new URL("dist/config.js", piRoot)))});
setEmbeddedQuickJSWasmPath(fileURLToPath(new URL("./resources/wasm/quickjs.wasm", import.meta.url)));
await import(${JSON.stringify(path.join(root, "src/desktop/backend.ts"))});\n`);
	for (const [source, filename, format] of [
		[path.join(root, "src/desktop/main.ts"), "main.mjs", "esm"],
		[path.join(root, "src/desktop/preload.ts"), "preload.cjs", "cjs"],
		[backendEntry, "backend.mjs", "esm"],
		[fileURLToPath(new URL("dist/utils/image-resize-worker.js", piRoot)), "image-resize-worker.js", "esm"],
	]) {
		const result = await Bun.build({
			entrypoints: [source],
			target: "node",
			format,
			define: { PI_BUNDLED_NODE: "true" },
			external: ["electron"],
			minify: true,
			plugins: [runtimePlugin()],
		});
		if (result.outputs.length !== 1) throw new Error(`Unexpected desktop outputs: ${filename}`);
		await writeFile(path.join(appDir, filename), await result.outputs[0].arrayBuffer());
	}
	await rm(backendEntry);
	await cp(ui, path.join(appDir, "ui"), { recursive: true });
	await cp(path.join(root, "assets/icons"), path.join(appDir, "icons"), { recursive: true });
	await cp(path.join(root, "NOTICE.md"), path.join(appDir, "resources/NOTICE.md"));
	const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
	await writeFile(
		path.join(appDir, "package.json"),
		JSON.stringify(
			{
				name: "pimoon",
				productName: "pimoon",
				desktopName: "pimoon.desktop",
				version,
				type: "module",
				main: "main.mjs",
				description: "pimoon SDK host",
				author: "Dream",
				license: "AGPL-3.0-only",
			},
			null,
			2,
		),
	);
	console.log(`Built desktop app: ${appDir}`);
	if (directoryOnly) return;
	if (platform.os === "win32" && process.platform !== "win32") process.env.USE_SYSTEM_WINE = "true";
	const { build, createTargets, Platform } = await import("electron-builder");
	const electronVersion = JSON.parse(
		await readFile(path.join(root, "node_modules/electron/package.json"), "utf8"),
	).version;
	await build({
		projectDir: appDir,
		targets: createTargets([Platform.fromString(platform.os)], undefined, platform.arch),
		config: {
			appId: "app.dream.pimoon",
			productName: "pimoon",
			executableName: "pimoon",
			artifactName: "pimoon.${ext}",
			electronVersion,
			asar: true,
			asarUnpack: ["backend.mjs", "image-resize-worker.js", "resources/**/*", "ui/**/*"],
			npmRebuild: false,
			protocols: [{ name: "pimoon", schemes: ["pimoon"] }],
			// 不接管原应用的通用 JSONL 文件关联。
			fileAssociations: [],
			directories: { output: path.join(output, "release") },
			files: ["**/*", "!**/*.map"],
			linux: { target: ["AppImage"], category: "Development", icon: "icons/linux", syncDesktopName: true },
			mac: {
				target: ["dmg"],
				category: "public.app-category.developer-tools",
				identity: "-",
				icon: "icons/icon.icns",
				extendInfo: {
					NSLocalNetworkUsageDescription: "pimoon 需要访问本地网络，以连接你配置的局域网模型 API 和其他本地服务。",
				},
			},
			win: { target: ["nsis"], icon: "icons/icon.ico" },
		},
	});
}
