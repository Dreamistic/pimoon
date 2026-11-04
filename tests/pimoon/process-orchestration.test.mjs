import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Runtime } from '../../src/pimoon/runtime.mjs';
import { runProcess } from '../../src/pimoon/codeact/process.ts';

const base=path.resolve('.tmp/tests/process-orchestration');
await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));
await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','execution.py','feedback.py','observations.py','worker_hooks.py']) await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const tool={name:'process_run',parameters:{type:'object',properties:{argv:{type:'array',items:{type:'string'}},timeout:{type:'number'},check:{type:'boolean'}}},outputSchema:{type:'object'}};
async function fixture(run,timeoutMs=7000){
 const cwd=await fs.mkdtemp(path.join(base,'case-'));
 const runtime=new Runtime({transport:'rust',cwd,tools:[tool],observe:false,timeoutMs});
 const calls=[];
 const context={tools:[tool],executeTool:async(_name,input,{signal})=>{
  calls.push(input);
  const result=await runProcess(input,cwd,signal);
  const isError=input.check!==false&&(result.status!=='exited'||result.exit_code!==0);
  return{isError,result:{content:[{type:'text',text:JSON.stringify(result)}],...(isError?{}:{structuredContent:result})}};
 }};
 try{await runtime.ready;await run({runtime,cwd,context,calls});}
 finally{const exited=once(runtime.child,'exit');runtime.close();await exited;}
}
const job=(code,extra={})=>({argv:[process.execPath,'-e',code],...extra});

test('独立进程批处理默认两并发，结果按输入排序，一项失败不重放其他项',()=>fixture(async({runtime,cwd,context})=>{
 const log=path.join(cwd,'events.jsonl');
 const jobs=Array.from({length:5},(_,i)=>job(`const fs=require('node:fs');const log=${JSON.stringify(log)};fs.appendFileSync(log,JSON.stringify({id:${i},event:'start'})+'\\n');setTimeout(()=>{console.log(${i});fs.appendFileSync(log,JSON.stringify({id:${i},event:'end'})+'\\n');process.exitCode=${i===2?7:0}},${i===0?350:100})`));
 const result=await runtime.run(`jobs=json.loads(${JSON.stringify(JSON.stringify(jobs))})\nrows=batch("process_run",jobs)\nassert [x["value"]["stdout"].strip() for x in rows if x["ok"]]==["0","1","3","4"]\nassert not rows[2]["ok"]\nlen(rows)`,context);
 assert.equal(result.isError,false,result.content[0].text);
 const events=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
 let active=0,peak=0;
 for(const event of events){active+=event.event==='start'?1:-1;peak=Math.max(peak,active);}
 assert.equal(active,0);assert.equal(peak,2);
 assert.equal(events.filter(e=>e.event==='start').length,5);
 assert.equal(result.details.metrics.internal_tool_calls,5);
 assert.equal(result.details.metrics.tool_failure_count,1);
}));

test('五个独立进程串行与两并发使用相同真实工作负载，记录墙钟而不设易抖动阈值',()=>fixture(async({runtime,context})=>{
 const jobs=Array.from({length:5},(_,i)=>job(`setTimeout(()=>console.log(${i}),200)`));
 const samples=[];
 for(let round=0;round<3;round++)for(const mode of round%2?['batch','serial']:['serial','batch']){
  const input=`jobs=json.loads(${JSON.stringify(JSON.stringify(jobs))})\n`;
  const source=mode==='serial'?'rows=[process_run(**item) for item in jobs]\n[x["stdout"].strip() for x in rows]':'rows=batch("process_run",jobs,limit=2)\nassert all(x["ok"] for x in rows)\n[x["value"]["stdout"].strip() for x in rows]';
  const start=performance.now(),result=await runtime.run(input+source,context);
  samples.push({mode,ms:Math.round(performance.now()-start)});
  assert.equal(result.isError,false,result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text.slice(3)),['0','1','2','3','4']);
  assert.equal(result.details.metrics.internal_tool_calls,5);
 }
 const median=mode=>samples.filter(x=>x.mode===mode).map(x=>x.ms).sort((a,b)=>a-b)[1];
 console.log(JSON.stringify({process_orchestration_benchmark:{jobs:5,delay_ms:200,serial_median_ms:median('serial'),batch2_median_ms:median('batch'),samples}}));
},20000));

test('进程批处理在派发前拒绝超过四并发',()=>fixture(async({runtime,context,calls})=>{
 const result=await runtime.run(`batch("process_run",[json.loads(${JSON.stringify(JSON.stringify(job('console.log(1)')))} )],limit=5)`,context);
 assert.equal(result.isError,true);assert.match(result.content[0].text,/process.*concurrency|process.*limit/i);assert.equal(calls.length,0);
}));

test('单个进程超时只中断依赖链，不清空 Python 变量或重启解释器',()=>fixture(async({runtime,context})=>{
 const pid=runtime.workerInfo.pid;
 const input=job('setInterval(()=>{},1000)',{timeout:0.3});
 const failed=await runtime.run(`saved=41\nprocess_run(**json.loads(${JSON.stringify(JSON.stringify(input))}))\nsaved=99`,context);
 assert.equal(failed.isError,true);assert.match(failed.content[0].text,/timeout/);
 assert.equal(runtime.hasState,true);
 const next=await runtime.run('saved+=1\nassert saved==42\nsaved',context);
 assert.equal(next.isError,false,next.content[0].text);assert.equal(runtime.workerInfo.pid,pid);
}));

test('进程预算早于代码块截止，返回可捕获的错误而非清空状态',()=>fixture(async({runtime,context,calls})=>{
 const events=[],pid=runtime.workerInfo.pid;
 const input=job('setInterval(()=>{},1000)',{timeout:30});
 const failed=await runtime.run(`saved=42\nprocess_run(**json.loads(${JSON.stringify(JSON.stringify(input))}))`,context,undefined,1,(type,fields)=>events.push({type,...fields}));
 assert.equal(failed.isError,true);assert.match(failed.content[0].text,/timeout/);
 assert.ok(calls[0].timeout>0&&calls[0].timeout<3);
 const capped=events.find(e=>e.type==='process_timeout_capped');
 assert.equal(capped.requested_seconds,30);assert.equal(capped.effective_seconds,calls[0].timeout);
 assert.ok(capped.remaining_ms>5000);assert.doesNotMatch(JSON.stringify(events),/setInterval/);
 assert.equal(events.some(e=>e.type==='runtime_state_lost'),false);
 const next=await runtime.run('assert saved==42\nprint("preserved")',context);
 assert.equal(next.isError,false,next.content[0].text);assert.equal(runtime.workerInfo.pid,pid);
}));

test('用户取消中止活动进程，不再派发排队项；取消仍明确丢失 Python 状态',()=>fixture(async({runtime,cwd,context,calls})=>{
 const events=[],controller=new AbortController();
 const jobs=Array.from({length:5},(_,i)=>job(`require('node:fs').writeFileSync('pid-${i}',String(process.pid));setInterval(()=>{},1000)`));
 const pending=runtime.run(`batch("process_run",json.loads(${JSON.stringify(JSON.stringify(jobs))}),limit=2)`,context,controller.signal,1,(type,fields)=>events.push({type,...fields}));
 const rejected=assert.rejects(pending,/cancel/i);
 const until=Date.now()+3000;
 while(Date.now()<until){if((await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')).length===2)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal((await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')).length,2);
 controller.abort();await rejected;
 assert.equal(calls.length,2);assert.equal(events.filter(e=>e.type==='bridge_tool_start').length,2);
 assert.equal(events.some(e=>e.type==='runtime_state_lost'),true);assert.equal(runtime.hasState,false);
 for(const file of (await fs.readdir(cwd)).filter(f=>f.startsWith('pid-'))){const pid=Number(await fs.readFile(path.join(cwd,file),'utf8'));assert.throws(()=>process.kill(pid,0));}
}));
