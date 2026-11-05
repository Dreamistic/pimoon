import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import { startModelServer } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";
import { executionMetrics, isExecutionResult } from "./native-result.ts";

const experiment = vi.hoisted(() => ({ enabled: false, delayMs: 0, active: 0, peak: 0 }));
vi.mock("../../src/pimoon/runtime.mjs", async load => {
 const original = await load<typeof import("../../src/pimoon/runtime.mjs")>();
 return { ...original, Runtime: class extends original.Runtime {
  constructor(options: ConstructorParameters<typeof original.Runtime>[0]) { super({ ...options, autoParallel: experiment.enabled }); }
 } };
});
vi.mock("../../src/harness/file-tools/pi/adapters/read.ts", async load => {
 const original = await load<typeof import("../../src/harness/file-tools/pi/adapters/read.ts")>();
 return { ...original, executeRead: async (...args: Parameters<typeof original.executeRead>) => {
  experiment.active++; experiment.peak = Math.max(experiment.peak, experiment.active);
  try {
   if (experiment.delayMs) await new Promise(resolve => setTimeout(resolve, experiment.delayMs));
   return await original.executeRead(...args);
  } finally { experiment.active--; }
 } };
});
afterEach(() => vi.unstubAllEnvs());

it.each(["assignment", "print"] as const)("A/B（%s）：同一源码经原生 execute、SDK 和真实文件工具执行，记录原始样本而不以噪声阈值断言加速", async shape => {
 const base = path.resolve(".tmp/tests/auto-parallel-ab"); await fs.mkdir(base, { recursive: true });
 const folder = await fs.mkdtemp(path.join(base, "case-"));
 const cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
 await fs.mkdir(cwd); await fs.mkdir(agentDir);
 for (let index = 0; index < 6; index++) await fs.writeFile(path.join(cwd, `${index}.txt`), Array.from({ length: 120 }, (_, line) => `fixture-${index}-${line} 原文`).join("\n"));
 vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
 const { CodeAct } = await import("../../src/pimoon/codeact/session.ts");
 const code = shape === "print"
  ? Array.from({ length: 6 }, (_, i) => `print(read(path="${i}.txt"))`).join("\n")
  : Array.from({ length: 6 }, (_, i) => `r${i}=read(path="${i}.txt")`).join("\n") + "\n[len(r0),len(r1),len(r2),len(r3),len(r4),len(r5)]";
 let responseNumber = 0;
 const server = await startModelServer(() => responseNumber++ % 2 === 0 ? { tool: "execute", args: { code, desc: "读取六份文件" } } : { text: "done" });
 await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
 await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
 } } }));
 const samples: Array<{ delay_ms: number; variant: string; phase: string; round: number; warmup: boolean; host_ms: number; compile_ms: number; python_ms: number; output_chars: number; peak: number }> = [];
 let expected: string | undefined;
 const start = async (enabled: boolean) => {
  experiment.enabled = enabled;
  return await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
   const codeact = new CodeAct();
   const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
    extensionFactories: [codeact.extension, { name: "file-tools", factory: fileTools }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   } });
   const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "read"] });
   codeact.bind(result.session);
   return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
 };
 try {
  for (const delay of [0, 20]) {
   experiment.delayMs = delay;
   // 每次创建独立会话；交错 AB/BA，避免缓存和系统负载始终偏向某一组。
   for (let round = 0; round < 9; round++) for (const enabled of round % 2 ? [true, false] : [false, true]) {
    const runtime = await start(enabled);
    try {
     await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
     for (const phase of ["cold", "warm"]) {
     experiment.peak = 0;
     await runtime.session.prompt("Read all six fixtures and return their lengths in one execute call.");
     const result = runtime.session.messages.filter(isExecutionResult).at(-1);
     expect(result?.isError).toBe(false);
     const text = JSON.stringify(result?.content);
     expected ??= text; expect(text).toBe(expected);
     const metrics = executionMetrics(result);
     const number = (key: string): number => { const value = metrics?.[key]; if (typeof value !== "number") throw new Error(`缺少指标 ${key}`); return value; };
     expect(number("internal_tool_calls")).toBe(6);
     expect(experiment.peak).toBe(enabled ? 6 : 1);
     expect(metrics["compile_cache_hit"]).toBe(phase === "warm");
     samples.push({ delay_ms: delay, variant: enabled ? "B" : "A", phase, round, warmup: round === 0,
      host_ms: number("host_ms"), compile_ms: number("compile_ms"), python_ms: number("python_ms"), output_chars: number("output_chars"), peak: experiment.peak });
     }
    } finally { await runtime.dispose(); }
   }
  }
  const median = (rows: number[]): number => {
   const sorted = [...rows].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
   const high = sorted[middle];
   if (high === undefined) throw new Error("没有有效样本");
   if (sorted.length % 2) return high;
   const low = sorted[middle - 1];
   if (low === undefined) throw new Error("没有中位数前项");
   return (low + high) / 2;
  };
  const summaries = [0, 20].flatMap(delay => ["cold", "warm"].map(phase => {
   const rows = (variant: string) => samples.filter(row => row.delay_ms === delay && row.phase === phase && row.variant === variant && !row.warmup).map(row => row.host_ms);
   const a = median(rows("A")), b = median(rows("B"));
   return { delay_ms: delay, phase, samples_per_variant: rows("A").length, A_median_ms: a, B_median_ms: b, speedup: a / b, reduction_percent: (a - b) / a * 100 };
  }));
  const report = { source: code, model: "deterministic fixture; not a live model or billing benchmark", samples, summaries };
  await fs.writeFile(path.join(base, shape === "print" ? "print-results.json" : "results.json"), JSON.stringify(report, null, 2));
  console.log("AUTO_PARALLEL_AB", shape, JSON.stringify(summaries));
 } finally { await server.close(); }
}, 120_000);
