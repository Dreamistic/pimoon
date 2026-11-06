import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { fixture, action } from "./native-fixture.ts";
import { executionScheduling } from "../../src/gui/shared/messages/scheduling.ts";
import { GuiLiveTools } from "../../src/gui/host/projection/live-tools.ts";
import { GuiPayloads } from "../../src/gui/host/projection/payloads.ts";
import { outputPreview } from "../../src/gui/shared/messages/output.ts";
afterEach(()=>vi.unstubAllEnvs());

it("真实混合并发实时投影、完成和重开保留时间线，元数据不进入模型正文",async()=>{
 const delayed: InlineExtension={name:"delay-read",factory(pi){pi.on("tool_call",async event=>{if(event.toolName==="read")await new Promise(resolve=>setTimeout(resolve,140));});}};
 const f=await fixture([action('items=parallel([(read,{"path":"a.txt"}),(native_read,{"path":"b.txt"}),(read,{"path":"c.txt"})])\nassert len(items)==3\n42'),{text:"done"}],undefined,[delayed]);
 const live=new GuiLiveTools(new GuiPayloads());const snapshots: unknown[]=[];
 const unsubscribe=f.runtime.session.subscribe(event=>{
  if(event.type==="tool_execution_start"||event.type==="tool_execution_update"||event.type==="tool_execution_end"){
   live.accept(event);
   if(event.type==="tool_execution_update"&&event.toolName==="execute")snapshots.push(outputPreview(live.project()[0]?.output)?.details);
  }
 });
 let sessionFile: string|undefined;
 try{
  for(const name of ["a","b","c"])await fs.writeFile(path.join(f.cwd,name+".txt"),name);
  await f.runtime.session.prompt("Run fixture.");
  const result=f.results()[0],trace=executionScheduling(result?.details);
  expect(trace?.state).toBe("completed");expect(trace?.groups[0]).toMatchObject({total:3,peak:3,state:"completed"});
  expect(trace?.groups[0]?.operations.map(x=>x.name)).toEqual(["read","native_read","read"]);
  expect(trace?.groups[0]?.operations.every(x=>x.state==="ok")).toBe(true);
  expect(snapshots.some(detail=>executionScheduling(detail)?.groups[0]?.operations.some(x=>x.state==="running"))).toBe(true);
  expect(JSON.stringify(f.server.requests.at(-1))).not.toContain("overlapMs");
  sessionFile=f.runtime.session.sessionManager.getSessionFile();
 }finally{unsubscribe();await f.close();}
 if(!sessionFile)throw Error("missing persisted session");
 const reopened=await fixture([{text:"done"}],undefined,[],{root:f.root,sessionFile});
 try {expect(executionScheduling(reopened.results()[0]?.details)?.groups[0]).toMatchObject({peak:3,total:3,state:"completed"});}
 finally {await reopened.close();}
});

it("收集失败只标记对应操作，未并发的后续写入不加入时间线",async()=>{
 const f=await fixture([action('rows=parallel([(read,{"path":"ok.txt"}),(native_read,{"path":"missing.txt"})],errors="collect")\nwrite(path="report.txt",content=str(sum(r["ok"] for r in rows)))'),{text:"done"}]);
 try {
  await fs.writeFile(path.join(f.cwd,"ok.txt"),"ok");await f.runtime.session.prompt("Run fixture.");
  expect(await fs.readFile(path.join(f.cwd,"report.txt"),"utf8")).toBe("1");
  const trace=executionScheduling(f.results()[0]?.details);
  expect(trace?.groups[0]?.operations.map(x=>x.state)).toEqual(["ok","error"]);
  expect(trace?.groups[0]?.state).toBe("failed");expect(trace?.groups[0]?.operations.some(x=>x.name==="write")).toBe(false);
 }finally{await f.close();}
});
