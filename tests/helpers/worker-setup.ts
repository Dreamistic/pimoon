import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// 测试从源码运行，不继承桌面版或打包 CLI 的资源目录。
delete process.env.PIMOON_RESOURCE_DIR;
delete process.env.PI_PACKAGE_DIR;

// Vitest 由 Node 运行。只替换测试中的 TS 加载入口，worker 仍执行正式解析代码。
vi.mock("../../src/harness/worker-runtime/typescript-worker.ts", async () => {
	const { Worker } = await import("node:worker_threads");
	return {
		createTypeScriptWorker: (entry: URL) => new Worker(new URL("./typescript-worker.mjs", import.meta.url), { workerData: entry.href }),
	};
});

// 普通测试不隐式调用远端审批模型；审批测试显式覆盖为自己的隔离配置。
process.env.PIMOON_APPROVAL_AI_CONFIG = fileURLToPath(new URL("./approval-disabled.jsonc", import.meta.url));
