import os from "node:os";
import path from "node:path";

// 解包入口也使用这些路径，不能提前加载依赖解包资源的 SDK。
const storageDirectory = () => path.resolve(process.env.PIMOON_HOME ?? path.join(process.env.APPDATA ?? os.homedir(), "pimoon"));
const userCacheDirectory = () => path.join(storageDirectory(), "cache");
export const resourceCacheDirectory = () => path.join(userCacheDirectory(), "pimoon");
export const userHistoryPath = () => path.join(userCacheDirectory(), "user-history", "history.jsonl");
export const telemetryRootDirectory = () => path.join(storageDirectory(), "telemetry");
export const telemetryRunsDirectory = () => path.join(telemetryRootDirectory(), "runs");
export const telemetryReportDirectory = () => path.join(storageDirectory(), "telemetry", "reports", "latest");
export const bashOutputDirectory = () => path.join(os.tmpdir(), "pimoon", "bash");
export const forkDirectoryPrefix = () => path.join(os.tmpdir(), "pimoon-subagent-fork-");
export const exportDirectoryPrefix = () => path.join(os.tmpdir(), "pimoon-export-");
