import fs from "node:fs/promises";
import path from "node:path";

/** 真实执行器测试只使用当前源码与隔离资源，不依赖已有桌面构建。 */
export async function createRuntimeResources(folder: string): Promise<string> {
	const resources = path.join(folder, "resources");
	await fs.mkdir(path.join(resources, "pimoon"), { recursive: true });
	for (const file of ["worker.py", "execution.py", "feedback.py", "worker_hooks.py", "observations.py"]) await fs.copyFile(path.join("src/pimoon", file), path.join(resources, "pimoon", file));
	await fs.copyFile("assets/runtime/pimoon-runtime.exe", path.join(resources, "pimoon/pimoon-runtime.exe"));
	return resources;
}
