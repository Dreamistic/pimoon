import fs from "node:fs/promises";
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
 const source = `rows=parallel([(read,{"path":"ok.txt"}),(read,{"path":"denied.txt"})],errors="${errors}")
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
 const f=await fixture([action(`a,b=parallel([(read,{"path":"a.txt"}),(read,{"path":"b.txt"})])
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
 read(path="missing.txt")
except ToolError as error:
 assert error.code=="FILE_NOT_FOUND"
rows=parallel([(read,{"path":"other-missing.txt"})],errors="collect")
assert rows[0]["error_code"]=="FILE_NOT_FOUND"
{"checked":True}`;
 const f=await fixture([action(code),{text:"done"}]);
 try {await f.runtime.session.prompt("Run fixture.");expect(f.results()[0]?.isError).toBe(false);expect(executionMetrics(f.results()[0])).toMatchObject({outcome:"tool_partial_failure",tool_failure_count:2});}
 finally {await f.close();}
});
