import fs from "node:fs/promises";
import path from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {fixture,action} from "./native-fixture.ts";
import {executionMetrics} from "./native-result.ts";
import program from "../fixtures/codeact-scheduling-natural.json" with {type:"json"};
import {scenarios} from "../../scripts/benchmark/scheduling-scenarios.mjs";

const settings=vi.hoisted(()=>({enabled:false}));
vi.mock("../../src/pimoon/runtime.mjs",async load=>{
 const original=await load<typeof import("../../src/pimoon/runtime.mjs")>();
 return {...original,Runtime:class extends original.Runtime{
  constructor(options:ConstructorParameters<typeof original.Runtime>[0]){super({...options,autoParallel:settings.enabled});}
 }};
});
afterEach(()=>vi.unstubAllEnvs());

it("同源重放真实模型程序：两条运行路径保留失败恢复、写入结果和读取计数",async()=>{
 const samples:Array<{round:number;variant:string;host_ms:number;requests:number;errors:boolean[];native_reads:number;compile_ms:number}>=[];
 let expectedErrors:boolean[]|undefined;
 for(let round=0;round<3;round++)for(const enabled of round%2?[true,false]:[false,true]){
  settings.enabled=enabled;
  const f=await fixture([...program.code.map(code=>action(code)),{text:"done"}],undefined,[],undefined,["execute","find","grep","ls","read","edit","write"]);
  try{
   await scenarios["conditional-edit"].setup(f.cwd);
   await f.runtime.session.prompt("Replay the recorded fixture program without changing its source.");
   await scenarios["conditional-edit"].verify(f.cwd);
   const results=f.results();expect(results).toHaveLength(program.code.length);
   const errors=results.map(result=>result.isError??false);expectedErrors??=errors;expect(errors).toEqual(expectedErrors);
   expect(f.server.requests).toHaveLength(program.code.length+1);
   const numbers=results.map(result=>executionMetrics(result));
   const total=(key:string)=>numbers.reduce((sum,metrics)=>{const value=metrics[key];if(typeof value!=="number")throw new Error(`缺少指标 ${key}`);return sum+value;},0);
   const nativeReads=total("native_read_calls_observed");expect(nativeReads).toBe(17);
   samples.push({round:round+1,variant:enabled?"B":"A",host_ms:total("host_ms"),requests:f.server.requests.length,errors,native_reads:nativeReads,compile_ms:total("compile_ms")});
  }finally{await f.close();}
 }
 const base=path.resolve(".tmp/tests/scheduling-replay");await fs.mkdir(base,{recursive:true});
 await fs.writeFile(path.join(base,"results.json"),JSON.stringify({origin:program.origin,samples},null,2));
},60000);
