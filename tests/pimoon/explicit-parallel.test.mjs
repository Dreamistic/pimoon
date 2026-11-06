import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {scheduleReads} from '../../src/pimoon/scheduler.mjs';
const base=path.resolve('.tmp/tests/explicit-parallel');await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','process_api.py','parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py'])await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const {Runtime}=await import('../../src/pimoon/runtime.mjs');
const tools=['read','ls','find','grep','write','edit','process_run'].map(name=>({name,parameters:{type:'object',properties:{path:{type:'string'},query:{type:'string'}}}}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(fn,{transport='direct',fail=null,observe=false}={}){
 const cwd=await fs.mkdtemp(path.join(base,'case-')),runtime=new Runtime({cwd,tools,transport,observe});
 let active=0,peak=0;const calls=[],events=[];
 const context={tools,executeTool:async(name,args)=>{
  calls.push([name,args]);active++;peak=Math.max(peak,active);
  try{await sleep(args.path==='fail'?1:12);return{isError:args.path===fail,result:{content:[{type:'text',text:args.path===fail?'fixture denied':JSON.stringify({name,...args})}]}};}finally{active--;}
 }};
 const run=code=>runtime.run(code,context,undefined,1,(type,fields)=>events.push({type,...fields}));
 try{await runtime.ready;await fn({runtime,run,calls,events,peak:()=>peak,context});}
 finally{const exit=once(runtime.child,'exit');runtime.close();runtime.child.ref();await exit;}
}
for(const transport of ['direct','rust']){
 test(`${transport}: 显式混合读取按输入顺序返回、跨块保留、缓存不重放`,()=>fixture(async({run,calls,events,peak})=>{
  const code='a,b,c=parallel([(read,{"path":"a"}),(ls,{"path":"b"}),(grep,{"query":"c"})])\n[a,b,c]';
  const first=await run(code);assert.equal(first.isError,false,first.content[0].text);assert.equal(peak(),3);
  assert.equal((await run('assert "a" in a and "b" in b and "c" in c')).isError,false);
  const cached=await run(code);assert.deepEqual(cached.content,first.content);assert.equal(cached.details.metrics.compile_cache_hit,true);assert.equal(calls.length,6);
  assert.equal(events.filter(x=>x.type==='schedule_start').length,2);assert.equal(events.find(x=>x.type==='schedule_start').mode,'explicit');
 },{transport}));
 for(const code of ['a=read(path="a")\nb=read(path="b")','print(read(path="a"))\nprint(read(path="b"))','items=[read(path=p) for p in ["a","b"]]','for p in ["a","b"]:\n read(path=p)','read(path="a")\nwrite(path="middle")\nread(path="b")'])
  test(`${transport}: 普通代码严格串行 ${code.split('\n')[0]}`,()=>fixture(async({run,peak,events})=>{
   const result=await run(code);assert.equal(result.isError,false,result.content[0].text);assert.equal(peak(),1);assert.ok(!events.some(x=>x.type==='schedule_start'));
  },{transport}));
}
test('动态过滤到显式映射，空组和单项不需特例，超过六项自动限流',()=>fixture(async({run,peak,calls})=>{
 const result=await run('paths=[str(i) for i in range(20) if i%2==0]\nvalues=parallel([(read,{"path":p}) for p in paths])\nassert len(values)==10\nassert parallel([])==[]\nassert len(parallel([(read,{"path":"single"})]))==1\nvalues');
 assert.equal(result.isError,false,result.content[0].text);assert.equal(peak(),6);assert.equal(calls.length,11);
}));
for(const code of [
 'parallel([(read,{"path":"first"}),(write,{"path":"bad"})])',
 'parallel([(read,{"path":"first"}),(subprocess.run,{"args":["node"]})])',
 'parallel([(read,{"path":"first"}),(lambda: 1,{})])',
 'parallel([(read,{"path":"first"}),(read,{"path":object()})])',
 'parallel([(read,{"path":"first"}),(native_read,{"path":"bad","lines":"1"})])',
 'parallel([(read,{"path":"first"})],errors="retry")',
 'parallel([(read,{"path":"first"})]*257)',
 'parallel([(read,{"path":"first"}),42])',
])test('整个任务描述先校验，不派发合法前项：'+code,()=>fixture(async({run,calls})=>{
 const result=await run(code);assert.equal(result.isError,true);assert.equal(calls.length,0);
}));
test('默认失败停止派发、保留逐项状态且阻止依赖写入',()=>fixture(async({run,calls})=>{
 const result=await run('paths=["fail"]+[str(i) for i in range(19)]\nvalues=parallel([(read,{"path":p}) for p in paths])\nwrite(path="never")');
 assert.equal(result.isError,true);assert.match(result.content[0].text,/ParallelError/);assert.equal(calls.length,6);assert.ok(!calls.some(x=>x[0]==='write'));
 const caught=await run('try:\n parallel([(read,{"path":"fail"}),(read,{"path":"ok"})])\nexcept ParallelError as error:\n saved=error.results\nassert saved[0]["ok"] is False and saved[1]["ok"] is True');
 assert.equal(caught.isError,false,caught.content[0].text);assert.equal(caught.details.metrics.outcome,'tool_partial_failure');
},{fail:'fail'}));
test('collect 完成所有项、失败不伪装成功、错误不重复登记',()=>fixture(async({run,calls})=>{
 const result=await run('paths=["fail"]+[str(i) for i in range(19)]\nrows=parallel([(read,{"path":p}) for p in paths],errors="collect")\nassert len(rows)==20 and sum(r["ok"] for r in rows)==19\nassert "elapsed_ms" not in rows[0]\nrows[0]');
 assert.equal(result.isError,false,result.content[0].text);assert.equal(calls.length,20);assert.equal(result.details.metrics.tool_failure_count,1);assert.equal(result.details.metrics.outcome,'tool_partial_failure');
},{fail:'fail'}));
test('工具重绑定与跨块旧代理不能获得并发资格',()=>fixture(async({runtime,run,calls})=>{
 const first=await run('old_read=read\nread=lambda **kw:"local"\nparallel([(read,{"path":"x"})])');assert.equal(first.isError,true);assert.equal(calls.length,0);
 const next=await run('parallel([(old_read,{"path":"x"})])');assert.equal(next.isError,true);assert.equal(calls.length,0);
 const removed=await runtime.run('parallel([(old_read,{"path":"x"})])',{tools:[],executeTool:async()=>{throw Error('must not call');}});assert.equal(removed.isError,true);
}));
for(const observe of [false,true])test(`print 保持原语义，输出与串行一致 observe=${observe}`,async()=>{
 let expected;
 await fixture(async({run})=>{expected=(await run('a=read(path="a")\nb=read(path="b")\nprint("A",a)\nprint("B",b)')).content;},{observe});
 await fixture(async({run})=>{const result=await run('a,b=parallel([(read,{"path":"a"}),(read,{"path":"b"})])\nprint("A",a)\nprint("B",b)');assert.deepEqual(result.content,expected);},{observe});
});
for(const errors of ['raise','collect'])test(`宿主上限与取消 ${errors}`,async()=>{
 let active=0,peak=0,started=0;
 const rows=await scheduleReads(Array.from({length:20},(_,i)=>({name:'read',args:{i}})),async(_,{i})=>{
  started++;active++;peak=Math.max(peak,active);try{await sleep(i===0?1:10);if(i===0)throw Error('denied');return i;}finally{active--;}
 },()=>false,()=>{},errors);
 assert.equal(peak,6);assert.equal(active,0);assert.equal(started,errors==='raise'?6:20);assert.equal(rows.filter(x=>x.skipped).length,errors==='raise'?14:0);
 let cancelled=false,count=0;await scheduleReads([{name:'read',args:{}},{name:'read',args:{}}],async()=>{count++;cancelled=true;return 'done';},()=>cancelled);assert.equal(count,1);
});
test('宿主独立拒绝进程写入与非法错误策略',async()=>{
 for(const name of ['write','edit','process_run','http'])await assert.rejects(scheduleReads([{name,args:{}}],async()=>{throw Error('must not call');}),/Invalid read schedule/);
 await assert.rejects(scheduleReads([{name:'read',args:{}}],async()=>{},()=>false,()=>{},'retry'),/Invalid read schedule/);
});
