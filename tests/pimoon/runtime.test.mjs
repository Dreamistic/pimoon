import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
const base=path.resolve('.tmp/tests/pimoon-runtime');await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','observations.py','worker_hooks.py'])await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const {Runtime,Decoder}=await import('../../src/pimoon/runtime.mjs');
async function runTest(fn,tools=[],observe=true,options={}){const cwd=await fs.mkdtemp(path.join(base,'case-'));const runtime=new Runtime({cwd,tools,observe,...options});try{await runtime.ready;await fn(runtime,cwd);}finally{const exit=once(runtime.child,'exit');runtime.close();await exit;}}
const context={tools:[],executeTool:async()=>{throw Error('unexpected tool');}};

for(const transport of ['rust','direct'])test(`${transport}: Python 直接分析外部文件，宿主读取共用凭据保护且不启动 shell`,async()=>{
 const outside=await fs.mkdtemp(path.join(base,'external-'));
 const protectedDir=path.join(outside,'credentials');await fs.mkdir(protectedDir);
 await fs.writeFile(path.join(protectedDir,'secret.txt'),'SYNTHETIC_SECRET');
 await fs.writeFile(path.join(outside,'events.jsonl'),' {"value":20}\n{"value":22}\n');
 await fs.writeFile(path.join(outside,'helper.py'),'def total(rows):\n    return sum(row["value"] for row in rows)\n');
 await fs.writeFile(path.join(outside,'large.txt'),'x'.repeat(4*1024*1024+1));
 await fs.writeFile(path.join(outside,'binary.txt'),Buffer.from([255]));
 await runTest(async(runtime,cwd)=>{
  await fs.symlink(protectedDir,path.join(cwd,'credential-link'),'junction');
  await fs.symlink(outside,path.join(cwd,'external-link'),'junction');
  const setup=`from pathlib import Path
import sys, json, os
external=Path(${JSON.stringify(outside)})
sys.path.insert(0,str(external))
from helper import total
rows=[json.loads(line) for line in (external / "events.jsonl").read_text(encoding="utf-8").splitlines()]
assert total(rows)==42
assert (external / "events.jsonl").name in os.listdir(external)
assert native_read(str(external / "events.jsonl")).strip().startswith('{')
assert Path("external-link/events.jsonl").read_text().strip().startswith('{')
print(total(rows))`;
  const result=await runtime.run(setup,context);assert.equal(result.isError,false,result.content[0].text);
  const next=await runtime.run('assert total(rows)==42\nassert os.environ["PIMOON_HOME"]\nassert isinstance(os.listdir(),list)\nassert isinstance(list(os.scandir()),list)\nprint("persistent")',context);assert.equal(next.isError,false,next.content[0].text);
  for(const code of [
   '(external / "new.txt").write_text("blocked")',
   '(external / "events.jsonl").unlink()',
   '(external / "events.jsonl").rename("moved.txt")',
   'Path("external-link/new.txt").write_text("blocked")',
   '(external / "credentials/secret.txt").read_text()',
   'Path("credential-link/secret.txt").read_text()',
   'native_read(str(external / "credentials/secret.txt"))',
   'native_read("credential-link/secret.txt")',
   'native_read(str(external / "large.txt"))',
   'native_read(str(external / "binary.txt"))',
   'import subprocess; subprocess.run(["python", "-V"])',
   'import socket; socket.socket()',
  ]){const denied=await runtime.run(code,context);assert.equal(denied.isError,true,code);assert.doesNotMatch(denied.content[0].text,/SYNTHETIC_SECRET/);}
  assert.equal(await fs.readFile(path.join(outside,'events.jsonl'),'utf8'),' {"value":20}\n{"value":22}\n');
  const write=await runtime.run('Path("summary.json").write_text(json.dumps({"total":total(rows)}))',context);assert.equal(write.isError,false,write.content[0].text);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,'summary.json'),'utf8')),{total:42});
 },[],false,{transport,protectedPaths:[protectedDir]});
});

test('真实 Python 持久性与 live-object 预览/回读',()=>runTest(async runtime=>{
 const first=await runtime.run('counter=41\nrows=list(range(1000))\nprint(rows)',context);
 assert.match(first.content[0].text,/@o1/);assert.equal(first.details.metrics.auto_observations,1);
 const pid=first.details.metrics.python_pid;
 const second=await runtime.run('counter+=1\nrows[0]=42\nassert get_observation("@o1")[0]==42\nassert counter==42\nprint(counter)',context);
 assert.equal(second.isError,false);assert.equal(second.details.metrics.python_pid,pid);assert.equal(second.details.metrics.observation_readbacks,1);
}));

test('native_read 失败捕获后仍保留，stderr 独立计数',()=>runTest(async(runtime,cwd)=>{
 await fs.writeFile(path.join(cwd,'sample.txt'),'synthetic');
 const result=await runtime.run('import sys\nassert native_read("sample.txt")=="synthetic"\ntry: native_read("missing.txt")\nexcept RuntimeError: pass\nprint("err",file=sys.stderr)',context);
 assert.equal(result.isError,false);assert.equal(result.details.metrics.native_read_calls_observed,2);assert.equal(result.details.metrics.native_read_trace[1].ok,false);assert.equal(result.details.metrics.stderr_chars,4);assert.equal(result.details.metrics.tool_failure_count,1);assert.match(result.content[0].text,/tool_failures/);
}));

test('异常与大输出的不完整状态均可见',()=>runTest(async runtime=>{
 const failure=await runtime.run('raise ValueError("synthetic failure")',context);assert.equal(failure.isError,true);assert.match(failure.content[0].text,/synthetic failure/);
 const result=await runtime.run('import sys\nsys.stdout.write("x"*(1024*1024+20))',context);
 assert.equal(result.details.metrics.output_complete,false);assert.equal(result.details.metrics.output_chars,1024*1024+20);assert.match(result.content[0].text,/Output retention incomplete/);
}));

test('取消清空内存但不回滚文件，下一次启动新 worker',()=>runTest(async(runtime,cwd)=>{
 const pid=runtime.workerInfo.pid;const abort=new AbortController();
 const pending=runtime.run('keep=42\nwith open("kept.txt","w") as file:\n file.write("kept")\nwhile True: pass',context,abort.signal);
 const rejected=assert.rejects(pending,/cancel/i);
 // 等待正文可见而非仅等待文件创建，避免在缓冲写入完成前取消。
 for(let n=0;n<200;n++){if(await fs.readFile(path.join(cwd,'kept.txt'),'utf8').catch(()=>null)==='kept')break;await new Promise(r=>setTimeout(r,10));}
 abort.abort();await rejected;assert.equal(runtime.hasState,false);assert.equal(await fs.readFile(path.join(cwd,'kept.txt'),'utf8'),'kept');
 const result=await runtime.run('assert "keep" not in globals()\nprint("fresh")',context);assert.equal(result.isError,false);assert.notEqual(result.details.metrics.python_pid,pid);
}));

test('结构化工具失败不丢错误，也不破坏返回值语义',async()=>{
 const tool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}},outputSchema:{type:'object'}};
 await runTest(async runtime=>{
  const result=await runtime.run('value=read(path="missing.txt")\nassert value["ok"] is False\nprint(value)',{tools:[tool],executeTool:async()=>({isError:true,result:{content:[{type:'text',text:'synthetic read failure'}],structuredContent:{ok:false}}})});
  assert.equal(result.isError,false);assert.equal(result.details.metrics.tool_failure_count,1);assert.match(result.content[0].text,/synthetic read failure/);
 },[tool]);
});

for(const reason of ['cancelled','timeout'])test(`CodeAct ${reason} 向宿主命令传递取消并可重建运行时`,()=>runTest(async runtime=>{
 const tool={name:'bash',parameters:{type:'object',properties:{command:{type:'string'}}}};
 const controller=new AbortController();let interrupted=false;
 const tools={tools:[tool],executeTool:async(_name,_args,{signal})=>{
  assert.ok(signal instanceof AbortSignal);
  await new Promise(resolve=>{
   const fallback=setTimeout(resolve,2000);
   signal.addEventListener('abort',()=>{interrupted=true;clearTimeout(fallback);resolve();},{once:true});
   if(reason==='cancelled')controller.abort();
  });
  throw Error('host command stopped');
 }};
 await assert.rejects(runtime.run('bash(command="fixture")',tools,controller.signal));
 assert.equal(interrupted,true);assert.equal(runtime.lastMetrics.outcome,reason);assert.equal(runtime.hasState,false);
 const recovered=await runtime.run('print("recovered")',context);
 assert.equal(recovered.isError,false);
},[{name:'bash',parameters:{type:'object',properties:{command:{type:'string'}}}}],false,{timeoutMs:1000}));

test('桌面普通输出保留定向 read 全文和 grep 匹配行，不做二次预览',async()=>{
 const tools=['read','grep'].map(name=>({name,parameters:{type:'object',properties:{}},...(name==='grep'?{outputSchema:{type:'object'}}:{})}));
 const text='<read newline="crlf">\n'+'x'.repeat(2100)+'\n.message.user { border-radius: 20px; }\n</read>';
 const match={regions:[{path:'App.css',lines:[{line:614,text:'border-radius: 20px;'}]}],truncated:false};
 await runTest(async runtime=>{
  const result=await runtime.run('print(read())\nprint(grep())',{tools,executeTool:async name=>({isError:false,result:{content:[{type:'text',text}],...(name==='grep'?{structuredContent:match}:{})}})});
  assert.equal(result.isError,false);assert.ok(result.content[0].text.includes(text));assert.match(result.content[0].text,/614/);assert.match(result.content[0].text,/border-radius: 20px/);assert.doesNotMatch(result.content[0].text,/@o\d|preview_complete/);
  assert.equal(result.details.metrics.auto_observations,0);
  const selected=await runtime.run('observe(list(range(1000)), limit=2)',context);assert.match(selected.content[0].text,/"shown": 2/);
 },tools,false);
});

test('宿主图片随 CodeAct 父结果原样返回，不残留到下一次执行',async()=>{
 const tool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
 const image={type:'image',data:Buffer.from('fixture image').toString('base64'),mimeType:'image/png'};
 await runTest(async runtime=>{
  const result=await runtime.run('print(read(path="sample.png"))',{tools:[tool],executeTool:async()=>({isError:false,result:{content:[{type:'text',text:'image loaded'},image]}})});
  assert.equal(result.isError,false);assert.match(result.content[0].text,/image loaded/);assert.deepEqual(result.content[1],image);
  const next=await runtime.run('print("next")',context);assert.equal(next.content.length,1);
 },[tool],false);
});

test('普通成功输出只保留状态和原文，耗时留在指标中',()=>runTest(async runtime=>{
 const empty=await runtime.run('pass',context);assert.equal(empty.content[0].text,'ok');
 const printed=await runtime.run('print("原始结果")',context);assert.equal(printed.content[0].text,'ok\n原始结果\n');assert.ok(printed.details.metrics.host_ms>=0);
 const failed=await runtime.run('raise ValueError("kept failure")',context);assert.match(failed.content[0].text,/^error\n/);assert.match(failed.content[0].text,/kept failure/);
},[],false));

test('batch 有界并发、按序返回，部分失败不吞错也不提前停止',async()=>{
 const tool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
 let active=0,peak=0,completed=0;
 await runTest(async runtime=>{
  const result=await runtime.run('items=batch("read", [{"path":str(i)} for i in range(5)], limit=2)\nassert [x["value"] for x in items if x["ok"]]==["0","1","3","4"]\nassert not items[2]["ok"]\nprint("batch complete")',{tools:[tool],executeTool:async(_name,args)=>{
   active++;peak=Math.max(peak,active);
   try{await new Promise(resolve=>setTimeout(resolve,args.path==='0'?20:5));completed++;return{isError:args.path==='2',result:{content:[{type:'text',text:args.path==='2'?'missing fixture':args.path}]}};}
   finally{active--;}
  }});
  assert.equal(result.isError,false);assert.equal(peak,2);assert.equal(completed,5);assert.match(result.content[0].text,/batch complete/);assert.match(result.content[0].text,/missing fixture/);assert.equal(result.details.metrics.tool_failure_count,1);
 },[tool],false);
});

test('预热只初始化，不执行代码；首次执行复用已就绪的 Python',()=>runTest(async runtime=>{
 const pid=runtime.workerInfo.pid;
 assert.equal(runtime.hasState,false);
 const result=await runtime.run('answer=42\nprint(answer)',context);
 assert.equal(result.details.metrics.python_pid,pid);assert.equal(runtime.hasState,true);
},[],false));

test('不同会话的预热进程不共享变量',()=>runTest(async first=>{
 await first.run('private_value=42',context);
 await runTest(async second=>{
  assert.notEqual(first.workerInfo.pid,second.workerInfo.pid);
  const result=await second.run('assert "private_value" not in globals()\nprint("isolated")',context);
  assert.equal(result.isError,false);assert.match(result.content[0].text,/isolated/);
 },[],false);
 const preserved=await first.run('assert private_value==42',context);assert.equal(preserved.isError,false);
},[],false));

test('Python 意外退出后标记内存丢失，下一次调用重新初始化',()=>runTest(async runtime=>{
 const pid=runtime.workerInfo.pid;
 await assert.rejects(runtime.run('private_value=42\nimport os\nos._exit(1)',context),/worker exited|state lost/i);
 assert.equal(runtime.hasState,false);
 const recovered=await runtime.run('assert "private_value" not in globals()\nprint("recovered")',context);
 assert.equal(recovered.isError,false);assert.notEqual(recovered.details.metrics.python_pid,pid);
},[],false));

test('预热尚未完成即可幂等关闭，不留下可用内存状态',async()=>{
 const cwd=await fs.mkdtemp(path.join(base,'early-close-'));
 const runtime=new Runtime({cwd,tools:[],observe:false});
 const exit=once(runtime.child,'exit');
 runtime.close();runtime.close();
 await assert.rejects(runtime.ready,/closed/);await exit;
 assert.equal(runtime.dead,true);assert.equal(runtime.hasState,false);
});

test('等待预热时取消关闭监督器管道，不强杀仍持有 Python 的父进程',async()=>{
 const cwd=await fs.mkdtemp(path.join(base,'startup-cancel-'));
 const runtime=new Runtime({cwd,tools:[],observe:false}), controller=new AbortController();
 const exit=once(runtime.child,'exit');
 const pending=runtime.run('print("unreachable")',context,controller.signal);
 const rejected=assert.rejects(pending,/cancel/i);
 controller.abort();await rejected;await exit;
 assert.equal(runtime.dead,true);assert.equal(runtime.hasState,false);
});

test('预热启动失败不会产生未处理拒绝，实际调用保留失败',async()=>{
 const folder=await fs.mkdtemp(path.join(base,'startup-failure-'));
 const runtime=new Runtime({cwd:path.join(folder,'missing'),tools:[],observe:false});
 await assert.rejects(runtime.ready);
 await assert.rejects(runtime.run('print("unreachable")',context),/unavailable/);
 runtime.close();runtime.close();assert.equal(runtime.hasState,false);
});

test('协议拒绝超过8MiB的帧',()=>{const header=Buffer.alloc(17);header.write('CA02');header.writeUInt32LE(8*1024*1024+1,13);assert.throws(()=>new Decoder(()=>{}).push(header),/8 MiB/);});

test('批次复盘关联 SDK 子调用，结构化失败计入批次但不改变返回语义',async()=>{
 const tool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}},outputSchema:{type:'object'}};
 await runTest(async runtime=>{
  const events=[];let id=0;
  const result=await runtime.run('items=batch("read", [{"path":"PRIVATE_PATH"},{"path":"missing"}], limit=2)\nassert all(item["ok"] for item in items)\nprint("PRIVATE_BODY")',{
   tools:[tool],executeTool:async()=>{const index=++id;return{toolCall:{id:`code/${index}`},isError:index===2,result:{content:[{type:'text',text:'PRIVATE_RESULT'}],structuredContent:{ok:index!==2}}};}
  },undefined,1,(type,fields)=>events.push({type,...fields}));
  const batch=events.find(event=>event.type==='batch_end');
  assert.equal(batch.jobs,2);assert.equal(batch.failed,1);assert.equal(batch.peak_concurrency,2);
  const calls=events.filter(event=>event.type==='bridge_tool_end');
  assert.deepEqual(calls.map(event=>event.tool_call_id),['code/1','code/2']);
  assert.ok(calls.every(event=>event.batch_id===batch.batch_id));
  assert.deepEqual(calls.map(event=>event.batch_index),[0,1]);
  assert.equal(result.details.metrics.outcome,'tool_partial_failure');
  assert.equal(result.details.metrics.metrics_complete,true);
  assert.equal(result.details.metrics.internal_tool_calls,2);assert.equal(result.details.metrics.internal_tool_failures,1);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_PATH|PRIVATE_BODY|PRIVATE_RESULT/);
 },[tool],false);
});

test('展示截断与保留丢失分别记录，筛选行数与回读错误可复盘',()=>runTest(async runtime=>{
 const output=await runtime.run('print("x"*50000)',context);
 assert.equal(output.details.metrics.display_truncated,true);
 assert.equal(output.details.metrics.output_complete,true);
 assert.equal(output.details.metrics.retained_output_chars,50001);
 assert.equal(output.details.metrics.model_returned_text_chars,output.content[0].text.length);
 const selected=await runtime.run('observe(list(range(100)), limit=3)\ntry: get_observation("@o999")\nexcept LookupError: pass',context);
 assert.equal(selected.details.metrics.observation_input_rows,100);
 assert.equal(selected.details.metrics.observation_shown_rows,3);
 assert.equal(selected.details.metrics.observation_readback_errors,1);
},[],false));

test('超时与 worker 崩溃各有终态，重建事件明确不恢复内存',()=>runTest(async runtime=>{
 const events=[],observe=(type,fields)=>events.push({type,...fields});
 await assert.rejects(runtime.run('while True: pass',context,undefined,1,observe),/cancel/i);
 assert.equal(runtime.lastMetrics.outcome,'timeout');assert.equal(runtime.lastMetrics.metrics_complete,false);
 assert.equal(events.find(event=>event.type==='runtime_state_lost').reason,'timeout');
 const recovered=await runtime.run('print("fresh")',context,undefined,1,observe);
 assert.equal(recovered.details.metrics.outcome,'success');
 const reinitialized=events.find(event=>event.type==='runtime_reinitialized');
 assert.equal(reinitialized.state_restored,false);assert.notEqual(reinitialized.previous_python_pid,reinitialized.python_pid);
 await assert.rejects(runtime.run('import os\nos._exit(1)',context,undefined,1,observe),/state lost/i);
 assert.equal(runtime.lastMetrics.outcome,'runtime_crash');
 assert.ok(events.some(event=>event.type==='runtime_state_lost'&&event.reason==='worker_exit'));
},[],false,{timeoutMs:500}));

test('已取消的执行不误报成功，观测器失败不改变业务结果',()=>runTest(async runtime=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(runtime.run('pass',context,controller.signal),/cancel/i);
 assert.equal(runtime.lastMetrics.outcome,'cancelled');assert.equal(runtime.lastMetrics.metrics_complete,false);
 const result=await runtime.run('print("kept")',context,undefined,1,()=>{throw Error('observer failure');});
 assert.equal(result.isError,false);assert.equal(result.details.metrics.outcome,'success');
 const failed=await runtime.run('raise ValueError("PRIVATE_ERROR")',context);
 assert.equal(failed.details.metrics.outcome,'python_error');assert.equal(failed.details.metrics.error_type,'ValueError');
 assert.doesNotMatch(JSON.stringify(failed.details.metrics),/PRIVATE_ERROR/);
},[],false));
