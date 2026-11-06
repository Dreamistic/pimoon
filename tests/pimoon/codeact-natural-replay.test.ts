import {afterEach,expect,it,vi} from "vitest";
import {fixture,action} from "./native-fixture.ts";
import {executionMetrics} from "./native-result.ts";
import program from "../fixtures/codeact-scheduling-natural.json" with {type:"json"};
import {scenarios} from "../../scripts/benchmark/scheduling-scenarios.mjs";
afterEach(()=>vi.unstubAllEnvs());

it("真实模型旧程序默认串行，保留失败恢复、修改结果和读取计数",async()=>{
 const f=await fixture([...program.code.map(code=>action(code)),{text:"done"}],undefined,[],undefined,["execute","find","grep","ls","read","edit","write"]);
 try{
  await scenarios["conditional-edit"].setup(f.cwd);
  await f.runtime.session.prompt("Replay the recorded fixture program without changing its source.");
  await scenarios["conditional-edit"].verify(f.cwd);
  const results=f.results();expect(results).toHaveLength(program.code.length);
  expect(f.server.requests).toHaveLength(program.code.length+1);
  const metrics=results.map(result=>executionMetrics(result));
  const total=(key:string)=>metrics.reduce((sum,row)=>{const value=row[key];if(typeof value!=="number")throw new Error(`缺少指标 ${key}`);return sum+value;},0);
  expect(total("native_read_calls_observed")).toBe(17);
  expect(total("batch_calls")).toBe(0);
 }finally{await f.close();}
},30000);
