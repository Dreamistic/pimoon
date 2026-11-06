import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runBuildTasks } from '../../scripts/build/tasks.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('独立构建拒绝已有目录，不删除或改写现有产物',async()=>{
 const base=path.resolve('.tmp/tests/build-tasks');await fs.mkdir(base,{recursive:true});
 const output=await fs.mkdtemp(path.join(base,'existing-'));await fs.writeFile(path.join(output,'sentinel'),'keep');
 await assert.rejects(promisify(execFile)('bun',['scripts/build.mjs','desktop','--dir','--output',output],{windowsHide:true}),/EEXIST/);
 assert.deepEqual(await fs.readdir(output),['sentinel']);assert.equal(await fs.readFile(path.join(output,'sentinel'),'utf8'),'keep');
});
for (const serial of [false,true]) test(`构建独立阶段按输入顺序返回，串行对照=${serial}`,async()=>{
 let active=0,peak=0;
 const result=await runBuildTasks([30,5,10].map((ms,i)=>({name:String(i),run:async()=>{active++;peak=Math.max(peak,active);await sleep(ms);active--;return i;}})),{serial,report:()=>{}});
 assert.deepEqual(result,[0,1,2]);assert.equal(peak,serial?1:3);assert.equal(active,0);
});
test('构建失败等待所有在途写入收尾，禁止过早清理',async()=>{
 let done=false;const logs=[];
 await assert.rejects(runBuildTasks([{name:'fail',run:async()=>{throw Error('expected');}},{name:'write',run:async()=>{await sleep(30);done=true;}}],{report:line=>logs.push(line)}),AggregateError);
 assert.equal(done,true);assert.equal(logs.length,2);
});
