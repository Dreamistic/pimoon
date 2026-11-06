import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
const base=path.resolve('.tmp/tests/auto-parallel-lifecycle');await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','process_api.py','parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py'])await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const {Runtime}=await import('../../src/pimoon/runtime.mjs');
const tool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
const tools=[tool];
const code='rows=parallel([(read,{"path":str(i)}) for i in range(12)])';
async function fixture(fn,options={}){
 const cwd=await fs.mkdtemp(path.join(base,'case-'));const runtime=new Runtime({cwd,tools,transport:'rust',observe:false,...options});
 try{await runtime.ready;await fn(runtime);}finally{const exit=once(runtime.child,'exit');runtime.close();runtime.child.ref();await exit;}
}
for(const form of ['assign','print'])for(const reason of ['cancelled','timeout'])test(`${form} 显式并发 ${reason}：中止在途调用，不启动余项，可重建且不重放`,()=>fixture(async runtime=>{
 const controller=new AbortController();let started=0,ended=0;
 let signalStarted;const ready=new Promise(resolve=>{signalStarted=resolve;});
 const context={tools,executeTool:async(_name,_args,{signal})=>{
  started++;if(started===12)signalStarted();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));ended++;throw Error('cancelled');
 }};
 const events=[];
 const source=code+(form==='print'?'\nprint(rows)':'');
 const pending=runtime.run(source,context,controller.signal,1,(type,fields)=>events.push({type,...fields}));
 await ready;if(reason==='cancelled')controller.abort();
 await assert.rejects(pending);
 assert.equal(started,12);assert.equal(ended,12);assert.equal(runtime.lastMetrics.outcome,reason);assert.equal(runtime.lastScheduling.state,'interrupted');assert.equal(runtime.lastScheduling.groups[0].state,'interrupted');
 assert.equal(events.find(event=>event.type==='runtime_state_lost').reason,reason);
 const next=await runtime.run('assert "r0" not in globals()\n"recovered"',{tools,executeTool:async()=>{throw Error('must not replay');}});
 assert.equal(next.isError,false,next.content[0].text);
},{timeoutMs:reason==='timeout'?500:5000}));
test('权限撤销后不复用旧代理，不发起任何读取',()=>fixture(async runtime=>{
 const denied=await runtime.run('a=read(path="a")\nb=read(path="b")',{tools:[],executeTool:async()=>{throw Error('must not invoke');}});
 assert.equal(denied.isError,true);assert.match(denied.content[0].text,/NameError/);assert.equal(denied.details.metrics.internal_tool_calls,0);
}));
test('拒绝后排空全部已派发读取，失败只登记一次',()=>fixture(async runtime=>{
 let started=0;
 const result=await runtime.run(code,{tools,executeTool:async(_name,args)=>{
  started++;await new Promise(resolve=>setTimeout(resolve,args.path==='0'?1:30));
  return{isError:args.path==='0',result:{content:[{type:'text',text:args.path==='0'?'denied':'done'}]}};
 }});
 assert.equal(result.isError,true);assert.equal(started,12);assert.equal(result.details.metrics.internal_tool_failures,1);
 assert.equal(result.details.metrics.tool_failure_count,1);assert.match(result.content[0].text,/"tool":"read"/);
}));

test('并发图片按源码而非完成顺序返回，结构化值及失败契约保持不变',()=>fixture(async runtime=>{
 const structured={...tool,outputSchema:{type:'object'}};
 const result=await runtime.run('rows=parallel([(read,{"path":"slow"}),(read,{"path":"fast"})],errors="collect")\nassert rows[0]["value"]["path"]=="slow" and not rows[1]["ok"]',{tools:[structured],executeTool:async(_name,args)=>{
  await new Promise(resolve=>setTimeout(resolve,args.path==='slow'?30:1));
  return{isError:args.path==='fast',result:{content:[{type:'text',text:args.path},{type:'image',data:args.path,mimeType:'image/png'}],structuredContent:{path:args.path}}};
 }});
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.outcome,'tool_partial_failure');
 assert.deepEqual(result.content.filter(part=>part.type==='image').map(part=>part.data),['slow','fast']);
}));
test('七十项显式读取在单组完成，后续表达式只执行一次',()=>fixture(async runtime=>{
 let calls=0;
 const source='items=parallel([(read,{"path":str(i)}) for i in range(70)])\nread(path="last")';
 const result=await runtime.run(source,{tools,executeTool:async(_name,args)=>{calls++;return{isError:false,result:{content:[{type:'text',text:args.path}]}};}});
 assert.equal(result.isError,false,result.content[0].text);assert.equal(calls,71);assert.equal(result.content[0].text,'ok\nlast\n');
}));

for(const call of ['read(path="thread")','read(path="thread.txt",mode="raw")'])test(`模型自建线程不能读写共享协议：${call}`,()=>fixture(async runtime=>{
 let calls=0;
 const result=await runtime.run('from concurrent.futures import ThreadPoolExecutor\nwith ThreadPoolExecutor(2) as pool:\n future=pool.submit(lambda: '+call+')\n future.result()',
  {tools,executeTool:async()=>{calls++;throw Error('must not reach host');}});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/synchronous calls on the execution thread/);assert.equal(calls,0);
 const next=await runtime.run('"protocol intact"',{tools,executeTool:async()=>{throw Error('must not call');}});
 assert.equal(next.isError,false,next.content[0].text);
}));

for(const transport of ['direct','rust'])test(`${transport}: 原文模式沿用宿主桥接，顺序、错误码与计数一致`,()=>fixture(async runtime=>{
 const calls=[];
 const context={tools,executeTool:async(_name,args)=>{
  calls.push(args);await new Promise(resolve=>setTimeout(resolve,args.path==='slow'?20:1));
  return args.path==='missing'?{isError:true,result:{content:[{type:'text',text:'missing'}],details:{status:'failed',error:{code:'FILE_NOT_FOUND'}}}}:
   {isError:false,result:{content:[{type:'text',text:args.path==='slow'?'原文😀\\r\\n':'other'}]}};
 }};
 const result=await runtime.run('assert "native_read" not in globals()\nrows=parallel([(read,{"path":p,"mode":"raw"}) for p in ["slow","missing","fast"]],errors="collect")\nassert rows[0]["ok"] and rows[2]["value"]=="other"\nassert rows[1]["error_code"]=="FILE_NOT_FOUND"',context);
 assert.equal(result.isError,false,result.content[0].text);assert.equal(calls.length,3);assert.ok(calls.every(args=>args.mode==='raw'));
 assert.equal(result.details.metrics.internal_tool_calls,3);assert.equal(result.details.metrics.tool_failure_count,1);
 const denied=await runtime.run('read(path="slow",mode="raw")',{tools:[],executeTool:async()=>{throw Error('must not call');}});
 assert.equal(denied.isError,true);assert.equal(calls.length,3);
},{transport}));
