import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ExecutionScheduling } from "./scheduling.ts";
export type RuntimeObserver = (type: string, fields: Record<string, unknown>) => void;
export class Runtime {
  constructor(options: { transport: "rust" | "direct"; observe: boolean; cwd: string; tools: readonly Pick<AgentTool, "name" | "parameters">[]; timeoutMs?: number; protectedPaths?: readonly string[] });
  dead: boolean;
  readonly ready: Promise<void>;
  readonly hasState: boolean;
  cwd: string;
  workerInfo?: { pid: number; python_version?: string };
  lastMetrics: Record<string, unknown>;
  lastScheduling?: ExecutionScheduling;
  run(code: string, context: ExtensionToolContext, signal?: AbortSignal, session?: number, onEvent?: RuntimeObserver, onScheduling?: (value: ExecutionScheduling) => void): Promise<AgentToolResult<{ runtime: string; metrics: Record<string, unknown>; scheduling: ExecutionScheduling }>>;
  close(): void;
}
