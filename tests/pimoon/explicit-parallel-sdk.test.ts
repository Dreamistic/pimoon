import fs from "node:fs/promises";
import { Type } from "typebox";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { fixture, action } from "./native-fixture.ts";
import { executionMetrics } from "./native-result.ts";
afterEach(() => vi.unstubAllEnvs());

it.each(["raise", "collect"])("显式组保留 SDK 权限拒绝和逐项身份：%s", async errors => {
 const guard: InlineExtension = { name: "deny-read", factory(pi) {
  pi.on("tool_call", event => event.toolName === "read" && event.input.path === "denied.txt" ? { block: true, reason: "explicit read denied" } : undefined);
 } };
 const source = `rows=parallel([(read,{"path":"ok.txt"}),(read,{"path":"denied.txt","mode":"raw"})],errors="${errors}")
${errors === "collect" ? 'assert rows[0]["ok"] and not rows[1]["ok"]' : 'write(path="never.txt",content="bad")'}`;
 const f = await fixture([action(source), {text:"done"}], undefined, [guard]);
 try {
  await fs.writeFile(path.join(f.cwd,"ok.txt"),"allowed");
  await fs.writeFile(path.join(f.cwd,"denied.txt"),"PRIVATE_DENIED_BODY");
  await f.runtime.session.prompt("Run fixture.");
  const result=f.results()[0];
  expect(result?.isError).toBe(errors === "raise");
  expect(JSON.stringify(result?.content)).toContain("explicit read denied");
  expect(JSON.stringify(result?.content)).not.toContain("PRIVATE_DENIED_BODY");
  expect(executionMetrics(result)).toMatchObject({batch_calls:1,batch_jobs:2,internal_tool_failures:1});
  expect(result?.nestedCalls?.calls.filter(call=>call.name === "read")).toHaveLength(2);
  await expect(fs.access(path.join(f.cwd,"never.txt"))).rejects.toThrow();
 } finally { await f.close(); }
});

it("组后修改复用读取观测；断言失败阻止后续写入",async()=>{
 const f=await fixture([action(`a,b=parallel([(read,{"path":"a.txt","mode":"raw"}),(read,{"path":"b.txt"})])
assert "old" in a
edit(path="a.txt",edits=[{"old":"old","new":"new"}])
assert False, "guard failed"
write(path="never.txt",content="bad")`),{text:"done"}],undefined,[],undefined,["execute","read","edit","write"]);
 try {
  await fs.writeFile(path.join(f.cwd,"a.txt"),"old");await fs.writeFile(path.join(f.cwd,"b.txt"),"other");
  await f.runtime.session.prompt("Run fixture.");
  expect(await fs.readFile(path.join(f.cwd,"a.txt"),"utf8")).toBe("new");
  expect(f.results()[0]?.isError).toBe(true);await expect(fs.access(path.join(f.cwd,"never.txt"))).rejects.toThrow();
 } finally {await f.close();}
});

it("文件错误码进入单项 ToolError 和并发结果，未知拒绝不伪装缺失",async()=>{
 const code = `try:
 read(path="missing.txt",mode="raw")
except ToolError as error:
 assert error.code=="FILE_NOT_FOUND"
rows=parallel([(read,{"path":"other-missing.txt"})],errors="collect")
assert rows[0]["error_code"]=="FILE_NOT_FOUND"
{"checked":True}`;
 const f=await fixture([action(code),{text:"done"}]);
 try {await f.runtime.session.prompt("Run fixture.");expect(f.results()[0]?.isError).toBe(false);expect(executionMetrics(f.results()[0])).toMatchObject({outcome:"tool_partial_failure",tool_failure_count:2});}
 finally {await f.close();}
});

it("原文解析不被审批备注污染，备注仍进入模型结果",async()=>{
 const guard: InlineExtension={name:"read-note",factory(pi){pi.on("tool_result",event=>{
  if(event.toolName==="read")return {content:[...event.content,{type:"text" as const,text:"Approval feedback (not new authorization): fixture note"}]};
 });}};
 const f=await fixture([action('data=json.loads(read(path="input.json",mode="raw"))\nassert data["value"]==42'),{text:"done"}],undefined,[guard]);
 try {
  await fs.writeFile(path.join(f.cwd,"input.json"),'{"value":42}');await f.runtime.session.prompt("Run fixture.");
  expect(f.results()[0]?.isError).toBe(false);
  expect(JSON.stringify(f.results()[0]?.content)).toContain("fixture note");
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("fixture note");
 } finally {await f.close();}
});
it("禁用 read 后没有独立原文入口可绕过",async()=>{
 const f=await fixture([action('assert "native_read" not in globals()\nread(path="private.txt",mode="raw")'),{text:"done"}],undefined,[],undefined,["execute"]);
 try{
  await fs.writeFile(path.join(f.cwd,"private.txt"),"PRIVATE_DISABLED_CONTENT");await f.runtime.session.prompt("Run fixture.");
  expect(f.results()[0]?.isError).toBe(true);
  expect(JSON.stringify(f.results()[0]?.content)).toContain("NameError");
  expect(JSON.stringify(f.results()[0]?.content)).not.toContain("PRIVATE_DISABLED_CONTENT");
 }finally{await f.close();}
});

it("工具结果替换正文时不从 details 恢复原文",async()=>{
 const guard: InlineExtension={name:"redact-read",factory(pi){pi.on("tool_result",event=>event.toolName==="read"?{content:[{type:"text" as const,text:"REDACTED"}]}:undefined);}};
 const f=await fixture([action('text=read(path="input.txt",mode="raw")\nassert text=="REDACTED"'),{text:"done"}],undefined,[guard]);
 try{await fs.writeFile(path.join(f.cwd,"input.txt"),"PRIVATE_REPLACED_CONTENT");await f.runtime.session.prompt("Run fixture.");expect(f.results()[0]?.isError).toBe(false);expect(JSON.stringify(f.results()[0]?.content)).not.toContain("PRIVATE_REPLACED_CONTENT");}
 finally{await f.close();}
});
it("独立原文读取中间缺失仍读完，缺少必需输入不写入",async()=>{
 const f=await fixture([action('paths=["a.json","b.json","missing.json","d.json","e.json"]\nrows=parallel([(read,{"path":p,"mode":"raw"}) for p in paths],errors="collect")\nassert rows[4]["ok"] and json.loads(rows[4]["value"])["value"]==4\nassert rows[2]["error_code"]=="FILE_NOT_FOUND"\nassert all(r["ok"] for r in rows), "Required inputs unavailable"\nwrite(path="never.txt",content="bad")'),{text:"done"}]);
 try{
  for(const [index,file] of ["a.json","b.json","missing.json","d.json","e.json"].entries())if(index!==2)await fs.writeFile(path.join(f.cwd,file),JSON.stringify({value:index}));
  await f.runtime.session.prompt("Run fixture.");expect(f.results()[0]?.isError).toBe(true);
  expect(executionMetrics(f.results()[0])).toMatchObject({internal_tool_calls:5,internal_tool_failures:1,batch_completed:5});
  expect(JSON.stringify(f.results()[0]?.content)).toContain("Required inputs unavailable");
  await expect(fs.access(path.join(f.cwd,"never.txt"))).rejects.toThrow();
 }finally{await f.close();}
});

it.each(["raise","collect"])("网页并发复用真实 SDK 逐项权限与嵌套身份：%s",async errors=>{
 const calls:string[]=[];
 const network:InlineExtension={name:"fixture-network",factory(pi){
  for(const name of ["websearch","webfetch","http"])pi.registerTool({
   name,label:name,description:"Synthetic network fixture.",parameters:Type.Object({query:Type.Optional(Type.String()),url:Type.Optional(Type.String())}),
   async execute(){calls.push(name);await new Promise(resolve=>setTimeout(resolve,20));return {content:[{type:"text",text:name+" allowed"}],details:{}};},
  });
  pi.on("tool_call",event=>event.toolName==="webfetch"?{block:true,reason:"network fixture denied"}:undefined);
 }};
 const f=await fixture([action(`rows=parallel([(websearch,{"query":"Tailscale"}),(webfetch,{"url":"https://example.com/docs"}),(http,{"url":"https://example.com/raw"})],errors="${errors}")
${errors==="collect"?'assert rows[0]["ok"] and not rows[1]["ok"] and rows[2]["ok"]':'write(path="never.txt",content="bad")'}`),{text:"done"}],undefined,[network],undefined,["execute","websearch","webfetch","http","write"]);
 try{
  await f.runtime.session.prompt("Run fixture.");
  const result=f.results()[0];expect(result?.isError).toBe(errors==="raise");
  expect(calls.sort()).toEqual(["http","websearch"]);
  expect(JSON.stringify(result?.content)).toContain("network fixture denied");
  expect(result?.nestedCalls?.calls.map(call=>call.name)).toEqual(["websearch","webfetch","http"]);
  expect(executionMetrics(result)).toMatchObject({internal_tool_calls:3,internal_tool_failures:1,batch_jobs:3});
  await expect(fs.access(path.join(f.cwd,"never.txt"))).rejects.toThrow();
 }finally{await f.close();}
});
