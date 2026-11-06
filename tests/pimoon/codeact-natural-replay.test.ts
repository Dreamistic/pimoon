import {afterEach,expect,it,vi} from "vitest";
import {fixture,action} from "./native-fixture.ts";
import {executionMetrics} from "./native-result.ts";
import program from "../fixtures/codeact-scheduling-natural.json" with {type:"json"};
import {scenarios} from "../../scripts/benchmark/scheduling-scenarios.mjs";
afterEach(()=>vi.unstubAllEnvs());

it("历史模型程序迁移原文 API 后保持串行及修改结果",async()=>{
 const f=await fixture([...program.code.map(code=>action(code.replaceAll("native_read(p)", 'read(path=p,mode="raw")'))),{text:"done"}],undefined,[],undefined,["execute","find","grep","ls","read","edit","write"]);
 try{
  await scenarios["conditional-edit"].setup(f.cwd);
  await f.runtime.session.prompt("Replay the fixture with the raw read API migrated.");
  await scenarios["conditional-edit"].verify(f.cwd);
  const results=f.results();expect(results).toHaveLength(program.code.length);
  expect(f.server.requests).toHaveLength(program.code.length+1);
  const metrics=results.map(result=>executionMetrics(result));
  const total=(key:string)=>metrics.reduce((sum,row)=>{const value=row[key];if(typeof value!=="number")throw new Error(`缺少指标 ${key}`);return sum+value;},0);
  expect(total("internal_tool_calls")).toBeGreaterThanOrEqual(17);
  expect(total("batch_calls")).toBe(0);
 }finally{await f.close();}
},30000);
