import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import processFunctions from "../../src/harness/extensions/codeact-functions.ts";
import approvalGate from "../../src/harness/extensions/approval-gate.ts";
import { CodeAct } from "../../src/pimoon/codeact/session.ts";
import { isExecutionResult, executionMetrics } from "./native-result.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { createRuntimeResources } from "./runtime-resources.ts";

afterEach(() => vi.unstubAllEnvs());
const job = (code: string, extra: { timeout?: number } = {}) => ({ argv: [process.execPath, "-e", code], ...extra });
async function fixture(codes: string[], gate = false) {
	const base = path.resolve(".tmp/tests/process-batch-sdk"); await fs.mkdir(base, { recursive: true });
	const folder = await fs.mkdtemp(path.join(base, "case-")), cwd = path.join(folder, "workspace"), agentDir = path.join(folder, "agent");
	await fs.mkdir(cwd); await fs.mkdir(agentDir);
	vi.stubEnv("PIMOON_RESOURCE_DIR", await createRuntimeResources(folder));
	const replies: ModelResponse[] = [...codes.map(code => ({ tool: "execute", args: { code, desc: "进程验证" } })), { text: "done" }];
	const server = await startModelServer(() => replies.shift() ?? { text: "done" });
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "test", retry: { enabled: false }, compaction: { enabled: false } }));
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: server.url, api: "openai-completions", apiKey: "fixture", models: [{ id: "test", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	try {
		const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
			const codeact = new CodeAct();
			const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories: [codeact.extension, { name: "process", factory: processFunctions }, ...(gate ? [{ name: "approval-gate", factory: approvalGate }] : [])], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
			const result = await createAgentSessionFromServices({ services, sessionManager, tools: ["execute", "process_run"] });
			codeact.bind(result.session); return { ...result, services, diagnostics: services.diagnostics };
		}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
		return { cwd, session: runtime.session, server, async close() { try { await runtime.dispose(); } finally { await server.close(); } } };
	} catch (error) { await server.close(); throw error; }
}


it("标准 subprocess 经过真实 SDK，超时不丢变量，依赖链按顺序执行",async()=>{
 const argv=(code:string)=>JSON.stringify(job(code).argv);
 const f=await fixture([
  `saved=41\nr=subprocess.run(${argv("console.error('expected');process.exit(7)")},capture_output=True,text=True)\nassert r.returncode==7`,
  `subprocess.run(${argv("setInterval(()=>{},1000)")},timeout=0.3,check=True)\nsaved=99`,
  `assert saved==41\nsubprocess.run(${argv("require('node:fs').writeFileSync('producer.txt','42')")},check=True)\nr=subprocess.run(${argv("console.log(require('node:fs').readFileSync('producer.txt','utf8'))")},capture_output=True,text=True,check=True)\nassert r.stdout.strip()=="42"\nsaved+=1\nsaved`,
 ]);
 try{
  let active=0,peak=0;f.session.subscribe(event=>{if(event.type==="tool_execution_start"&&event.toolName==="process_run"){active++;peak=Math.max(peak,active);}if(event.type==="tool_execution_end"&&event.toolName==="process_run")active--;});
  await f.session.bindExtensions({mode:"print",onError:({error})=>{throw new Error(error);}});
  await f.session.prompt("Run standard subprocess workflows.");
  const results=f.session.messages.filter(isExecutionResult);expect(results.map(result=>result.isError)).toEqual([false,true,false]);
  expect(executionMetrics(results[2]).python_pid).toBe(executionMetrics(results[0]).python_pid);expect(peak).toBe(1);expect(active).toBe(0);
  expect(JSON.stringify(results[1]?.content)).toContain("TimeoutExpired");expect(JSON.stringify(results[2]?.content)).toContain("42");
  for(const request of f.server.requests){expect(request.tools?.map(tool=>tool.function.name)).toEqual(["execute"]);const text=JSON.stringify(request.tools);expect(text).toContain("subprocess.run");expect(text).not.toContain("process_run(");expect(text).not.toContain("batch(");}
 }finally{await f.close();}
});
it("统一 parallel 经真实 SDK 并发进程，结果与调度投影一致",async()=>{
 const commands=[0,1,2].map(i=>({args:job(`setTimeout(()=>console.log(${i}),150)`).argv,check:true,capture_output:true,text:true}));
 const code=`values=parallel([(subprocess.run,kw) for kw in json.loads(${JSON.stringify(JSON.stringify(commands))})])\nassert [r.stdout.strip() for r in values]==["0","1","2"]`;
 const f=await fixture([code]);
 try{
  let active=0,peak=0;f.session.subscribe(event=>{if(event.type==="tool_execution_start"&&event.toolName==="process_run"){active++;peak=Math.max(peak,active);}if(event.type==="tool_execution_end"&&event.toolName==="process_run")active--;});
  await f.session.bindExtensions({mode:"print",onError:({error})=>{throw new Error(error);}});await f.session.prompt("Run independent checks.");
  const result=f.session.messages.find(isExecutionResult);expect(result?.isError).toBe(false);expect(peak).toBe(2);expect(active).toBe(0);
  expect(JSON.stringify(result)).toContain("subprocess.run");expect(executionMetrics(result).batch_peak_concurrency).toBe(2);
 }finally{await f.close();}
});
it("统一 parallel 逐项经过 SDK 审批，拒绝后队列不启动也不写入",async()=>{
 const commands=[0,1,2].map(i=>({args:job(`require('node:fs').writeFileSync('denied-${i}','bad')`).argv,check:true}));
 const f=await fixture([`parallel([(subprocess.run,kw) for kw in json.loads(${JSON.stringify(JSON.stringify(commands))})])`],true);
 try{
  await f.session.bindExtensions({mode:"print",onError:({error})=>{throw new Error(error);}});await f.session.prompt("Approval must block every process.");
  const result=f.session.messages.find(isExecutionResult);expect(result?.isError).toBe(true);expect(JSON.stringify(result?.content)).toMatch(/approval|审批/iu);
  for(let i=0;i<3;i++)await expect(fs.access(path.join(f.cwd,`denied-${i}`))).rejects.toThrow();
  expect(executionMetrics(result).internal_tool_calls).toBe(2);
 }finally{await f.close();}
});
it("标准 subprocess 仍逐项经过真实审批，拒绝后不产生进程副作用",async()=>{
 const argv=job("require('node:fs').writeFileSync('denied','bad')").argv;
 const f=await fixture([`subprocess.run(${JSON.stringify(argv)},check=True)`],true);
 try{await f.session.bindExtensions({mode:"print",onError:({error})=>{throw new Error(error);}});await f.session.prompt("Approval must block execution.");
 const result=f.session.messages.find(isExecutionResult);expect(result?.isError).toBe(true);expect(JSON.stringify(result?.content)).toMatch(/approval|审批/iu);await expect(fs.access(path.join(f.cwd,"denied"))).rejects.toThrow();
 }finally{await f.close();}
});
