import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
const base=path.resolve('.tmp/tests/auto-parallel-lifecycle');await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','process_api.py','auto_parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py'])await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const {Runtime}=await import('../../src/pimoon/runtime.mjs');
const tool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
const tools=[tool];
const code=Array.from({length:12},(_,i)=>`r${i}=read(path="${i}")`).join('\n');
async function fixture(fn,options={}){
 const cwd=await fs.mkdtemp(path.join(base,'case-'));const runtime=new Runtime({cwd,tools,transport:'rust',observe:false,autoParallel:true,...options});
 try{await runtime.ready;await fn(runtime);}finally{const exit=once(runtime.child,'exit');runtime.close();runtime.child.ref();await exit;}
}
for(const form of ['assign','print'])for(const reason of ['cancelled','timeout'])test(`${form} 自动调度 ${reason}：中止在途调用，不启动余项，可重建且不重放`,()=>fixture(async runtime=>{
 const controller=new AbortController();let started=0,ended=0;
 let signalStarted;const ready=new Promise(resolve=>{signalStarted=resolve;});
 const context={tools,executeTool:async(_name,_args,{signal})=>{
  started++;if(started===6)signalStarted();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));ended++;throw Error('cancelled');
 }};
 const events=[];
 const source=form==='print'?Array.from({length:12},(_,i)=>`print(read(path="${i}"))`).join('\n'):code;
 const pending=runtime.run(source,context,controller.signal,1,(type,fields)=>events.push({type,...fields}));
 await ready;if(reason==='cancelled')controller.abort();
 await assert.rejects(pending);
 assert.equal(started,6);assert.equal(ended,6);assert.equal(runtime.lastMetrics.outcome,reason);
 assert.equal(events.find(event=>event.type==='runtime_state_lost').reason,reason);
 const next=await runtime.run('assert "r0" not in globals()\n"recovered"',{tools,executeTool:async()=>{throw Error('must not replay');}});
 assert.equal(next.isError,false,next.content[0].text);
},{timeoutMs:reason==='timeout'?500:5000}));
test('权限撤销后不复用旧代理，不发起任何读取',()=>fixture(async runtime=>{
 const denied=await runtime.run('a=read(path="a")\nb=read(path="b")',{tools:[],executeTool:async()=>{throw Error('must not invoke');}});
 assert.equal(denied.isError,true);assert.match(denied.content[0].text,/NameError/);assert.equal(denied.details.metrics.internal_tool_calls,0);
}));
test('拒绝后仅已派发的六次读取排空，不把未启动项伪装为工具失败',()=>fixture(async runtime=>{
 let started=0;
 const result=await runtime.run(code,{tools,executeTool:async(_name,args)=>{
  started++;await new Promise(resolve=>setTimeout(resolve,args.path==='0'?1:30));
  return{isError:args.path==='0',result:{content:[{type:'text',text:args.path==='0'?'denied':'done'}]}};
 }});
 assert.equal(result.isError,true);assert.equal(started,6);assert.equal(result.details.metrics.internal_tool_failures,1);
 assert.equal(result.details.metrics.tool_failure_count,1);assert.match(result.content[0].text,/"tool":"read"/);
}));

test('并发图片按源码而非完成顺序返回，结构化值及失败契约保持不变',()=>fixture(async runtime=>{
 const structured={...tool,outputSchema:{type:'object'}};
 const result=await runtime.run('a=read(path="slow")\nb=read(path="fast")\nassert a["path"]=="slow" and b["path"]=="fast"',{tools:[structured],executeTool:async(_name,args)=>{
  await new Promise(resolve=>setTimeout(resolve,args.path==='slow'?30:1));
  return{isError:args.path==='fast',result:{content:[{type:'text',text:args.path},{type:'image',data:args.path,mimeType:'image/png'}],structuredContent:{path:args.path}}};
 }});
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.outcome,'tool_partial_failure');
 assert.deepEqual(result.content.filter(part=>part.type==='image').map(part=>part.data),['slow','fast']);
}));
test('超过单组上限分段调度，最后表达式及所有赋值仍只执行一次',()=>fixture(async runtime=>{
 let calls=0;
 const source=Array.from({length:70},(_,i)=>`r${i}=read(path="${i}")`).join('\n')+'\nread(path="last")';
 const result=await runtime.run(source,{tools,executeTool:async(_name,args)=>{calls++;return{isError:false,result:{content:[{type:'text',text:args.path}]}};}});
 assert.equal(result.isError,false,result.content[0].text);assert.equal(calls,71);assert.equal(result.content[0].text,'ok\nlast\n');
}));

for(const call of ['read(path="thread")','native_read("thread.txt")'])test(`模型自建线程不能读写共享协议：${call}`,()=>fixture(async runtime=>{
 let calls=0;
 const result=await runtime.run('from concurrent.futures import ThreadPoolExecutor\nwith ThreadPoolExecutor(2) as pool:\n future=pool.submit(lambda: '+call+')\n future.result()',
  {tools,executeTool:async()=>{calls++;throw Error('must not reach host');}});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/synchronous calls on the execution thread/);assert.equal(calls,0);
 const next=await runtime.run('"protocol intact"',{tools,executeTool:async()=>{throw Error('must not call');}});
 assert.equal(next.isError,false,next.content[0].text);
}));

for(const transport of ['direct','rust'])test(`${transport}: 原文推导式自动并行保留 Unicode、重复键、读取计数和失败`,()=>fixture(async runtime=>{
 await fs.writeFile(path.join(runtime.cwd,'a.txt'),'原文😀a');await fs.writeFile(path.join(runtime.cwd,'b.txt'),'原文😀b');
 const context={tools,executeTool:async()=>{throw Error('native read is not an SDK tool');}};
 const events=[];
 const result=await runtime.run('paths=["a.txt","b.txt","a.txt"]\nraw={p:native_read(p) for p in paths}\nassert raw=={"a.txt":"原文😀a","b.txt":"原文😀b"}\nassert "p" not in globals()',context,undefined,1,(type,fields)=>events.push({type,...fields}));
 assert.equal(result.isError,false,result.content[0].text);assert.equal(result.details.metrics.native_read_calls_observed,3);assert.equal(result.details.metrics.internal_tool_calls,0);
 assert.equal(events.filter(event=>event.type==='scheduled_native_read').length,3);
 const failure=await runtime.run('raw2=[native_read(p) for p in ["a.txt","missing.txt","b.txt"]]',context);
 assert.equal(failure.isError,true);assert.equal(failure.details.metrics.native_read_calls_observed,3);assert.equal(failure.details.metrics.tool_failure_count,1);
 assert.equal((await runtime.run('assert "raw2" not in globals()',context)).isError,false);
},{transport}));
test('自动原文读取仍拒绝受保护路径；前项结果不丢且不泄露文件内容',async()=>{
 const protectedDir=await fs.mkdtemp(path.join(base,'protected-'));await fs.writeFile(path.join(protectedDir,'private.txt'),'SYNTHETIC_SECRET');
 await fixture(async runtime=>{
  await fs.writeFile(path.join(runtime.cwd,'a.txt'),'allowed');
  const context={tools,executeTool:async()=>{throw Error('must not call');}};
  const source='a=native_read("a.txt")\nb=native_read('+JSON.stringify(path.join(protectedDir,'private.txt'))+')';
  const result=await runtime.run(source,context);assert.equal(result.isError,true);assert.doesNotMatch(result.content[0].text,/SYNTHETIC_SECRET/);
  assert.equal((await runtime.run('assert a=="allowed"\nassert "b" not in globals()',context)).isError,false);
 },{protectedPaths:[protectedDir]});
});

test('原文读取签名错误退回 Python，不被调度器改成别的错误类型',()=>fixture(async runtime=>{
 const context={tools,executeTool:async()=>{throw Error('must not call');}};
 for(const source of ['a=native_read(path="a",lines="1")\nb=native_read("b")','values=[native_read(path=p,lines="1") for p in ["a","b"]]','values=[native_read(path=1) for p in ["a","b"]]']){
  const events=[];const result=await runtime.run(source,context,undefined,1,type=>events.push(type));
  assert.equal(result.isError,true);assert.match(result.content[0].text,/TypeError/);assert.ok(!events.includes('schedule_start'));
 }
}));

for(const transport of ['direct','rust'])test(`${transport}: 打印原文与工具结果混合并行，保持 Unicode 和输出顺序`,()=>fixture(async runtime=>{
 await fs.writeFile(path.join(runtime.cwd,'a.txt'),'原文😀a');await fs.writeFile(path.join(runtime.cwd,'c.txt'),'原文😀c');
 const events=[];
 const result=await runtime.run('print(native_read("a.txt"))\nprint(read(path="b.txt"))\nprint(native_read("c.txt"))',
  {tools,executeTool:async()=>({isError:false,result:{content:[{type:'text',text:'工具😀b'}]}})},
  undefined,1,(type,fields)=>events.push({type,...fields}));
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.content[0].text,'ok\n原文😀a\n工具😀b\n原文😀c\n');
 assert.equal(result.details.metrics.native_read_calls_observed,2);assert.equal(result.details.metrics.internal_tool_calls,1);
 assert.equal(events.filter(event=>event.type==='scheduled_native_read').length,2);
 assert.equal(events.filter(event=>event.type==='schedule_start').length,1);
},{transport}));
