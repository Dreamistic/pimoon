import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { scenarios as scheduling } from "./scheduling-scenarios.mjs";
import { scenarios as files } from "./tool-scenarios.mjs";

// 不指定函数调用源码，观察模型能否自然选择显式并发与串行副作用。
export const scenarios = {
 "independent-review": scheduling["independent-review"],
 "conditional-edit": files["conditional-edit"],
 "optional-inputs": {
  prompt: "读取 inputs 下 a.json、b.json、c.json、d.json、e.json、f.json 六个已知输入，可能有文件缺失；缺失应逐项记录而不是中止其他输入。将成功读取的 amount 总和 total 和缺失文件名按字典序组成的 missing 数组写入 report.json，不修改输入。最后简短报告结果。",
  async setup(cwd) {
   await fs.mkdir(path.join(cwd,"inputs"));
   for (const [name,amount] of [["a",2],["b",3],["d",5],["f",7]]) await fs.writeFile(path.join(cwd,"inputs",name+".json"),JSON.stringify({amount}));
  },
  async verify(cwd) {
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,"report.json"),"utf8")),{total:17,missing:["c.json","e.json"]});
   for (const [name,amount] of [["a",2],["b",3],["d",5],["f",7]]) assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,"inputs",name+".json"),"utf8")),{amount});
   assert.deepEqual((await fs.readdir(path.join(cwd,"inputs"))).sort(),["a.json","b.json","d.json","f.json"]);
  },
 },
};
