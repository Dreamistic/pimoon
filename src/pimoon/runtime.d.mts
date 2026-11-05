import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
export type RuntimeObserver = (type: string, fields: Record<string, unknown>) => void;
export class Runtime {
  constructor(options: { transport: "rust" | "direct"; observe: boolean; cwd: string; tools: readonly Pick<AgentTool, "name" | "parameters">[]; autoParallel?: boolean; timeoutMs?: number; protectedPaths?: readonly string[] });
  dead: boolean;
  readonly ready: Promise<void>;
  readonly hasState: boolean;
  cwd: string;
  workerInfo?: { pid: number; python_version?: string };
  lastMetrics: Record<string, unknown>;
  run(code: string, context: ExtensionToolContext, signal?: AbortSignal, session?: number, onEvent?: RuntimeObserver): Promise<AgentToolResult<{ runtime: string; metrics: Record<string, unknown> }>>;
  close(): void;
}
