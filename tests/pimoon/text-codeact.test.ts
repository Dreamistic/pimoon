import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import processFunctions from "../../src/harness/extensions/codeact-functions.ts";
import { action, fixture } from "./native-fixture.ts";
import { executionMetrics } from "./native-result.ts";

afterEach(() => vi.unstubAllEnvs());
it("单一 execute 编排十二次混合调用，跨轮复用，文本伪代码不执行", async () => {
    const code = `from statistics import mean
paths=[f"{i}.txt" for i in range(8)]
rows=[read(path=p) for p in paths]
selected=[p for i,p in enumerate(paths) if i%2==0]
for p in selected:
 i=int(p.split(".")[0])
 edit(path=p, edits=[{"old":f"value-{i}","new":f"changed-{i}"}])
{"reads":len(rows),"edited":len(selected),"mean":mean(range(len(rows)))}`;
    const value = await fixture([action(code), action('assert len(rows)==8 and len(selected)==4\n{"retained":len(rows),"previous_mean":_["mean"]}'), { text: "done" },
        { text: '<execute>\nwrite(path="never.txt",content="bad")\n</execute>' }],
        undefined, [], undefined, ["execute", "read", "write", "edit"]);
    try {
        for (let i=0;i<8;i++) await fs.writeFile(path.join(value.cwd,`${i}.txt`),`value-${i}`);
        await value.runtime.session.prompt("Run workflow.");
        expect(value.results()).toHaveLength(2);
        expect(value.results().every(result=>!result.isError)).toBe(true);
        expect(executionMetrics(value.results()[0])).toMatchObject({ internal_tool_calls:12, internal_tool_failures:0 });
        for(let i=0;i<8;i++) expect(await fs.readFile(path.join(value.cwd,`${i}.txt`),"utf8")).toBe(`${i%2===0?"changed":"value"}-${i}`);
        await value.runtime.session.prompt("Text is not execution.");
        await expect(fs.access(path.join(value.cwd,"never.txt"))).rejects.toThrow();
        expect(value.results()).toHaveLength(2);
        for(const request of value.server.requests) expect(request.tools?.map(tool=>tool.function.name)).toEqual(["execute"]);
    } finally { await value.close(); }
});
it("进程失败阻止依赖步骤，不通过 Shell 执行", async () => {
    const argv = [process.execPath,"-e","process.exit(7)"];
    const value=await fixture([action(`subprocess.run(${JSON.stringify(argv)},check=True)\nfrom pathlib import Path\nPath("never.txt").write_text("bad")`),{text:"done"}],
        undefined,[{name:"process",factory:processFunctions}],undefined,["execute","process_run"]);
    try {
        await value.runtime.session.prompt("Run failure.");
        expect(value.results()[0]?.isError).toBe(true);
        expect(executionMetrics(value.results()[0])).toMatchObject({internal_tool_calls:1});
        await expect(fs.access(path.join(value.cwd,"never.txt"))).rejects.toThrow();
    } finally { await value.close(); }
});
