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
for(const file of ['worker.py','process_api.py','parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py']) await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const tool={name:'process_run',parameters:{type:'object',properties:{argv:{type:'array',items:{type:'string'}},timeout:{type:'number'},check:{type:'boolean'}}},outputSchema:{type:'object'}};
async function fixture(run,timeoutMs=7000,transport='rust'){
 const cwd=await fs.mkdtemp(path.join(base,'case-'));
 const runtime=new Runtime({transport,cwd,tools:[tool],observe:false,timeoutMs});
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
const parallelCode=(commands, policy='raise')=>`parallel([(subprocess.run,kw) for kw in json.loads(${JSON.stringify(JSON.stringify(commands.map(command=>({args:job(command).argv,capture_output:true,text:true,check:true}))))})],errors=${JSON.stringify(policy)})`;

test('统一进程并发最多两个，顺序结果为 CompletedProcess，普通后继等待全组结束',()=>fixture(async({runtime,cwd,context})=>{
 const commands=Array.from({length:4},(_,i)=>`setTimeout(()=>{require('node:fs').writeFileSync('done-${i}','ok');console.log(${i})},${i===0?250:70})`);
 const result=await runtime.run(`saved=42\nvalues=${parallelCode(commands)}\nassert [v.stdout.strip() for v in values]==["0","1","2","3"]\nassert all(isinstance(v,subprocess.CompletedProcess) for v in values)\nassert saved==42`,context);
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.batch_peak_concurrency,2);
 assert.equal(result.details.scheduling.groups[0].state,'completed');
 assert.deepEqual(result.details.scheduling.groups[0].operations.map(op=>op.name),Array(4).fill('subprocess.run'));
 assert.equal((await fs.readdir(cwd)).filter(x=>x.startsWith('done-')).length,4);
}));

for(const policy of ['raise','collect'])test(`进程非零退出在宿主停止派发，已有副作用不回滚 ${policy}`,()=>fixture(async({runtime,cwd,context,calls})=>{
 const commands=[`console.error('expected');process.exit(7)`,`setTimeout(()=>require('node:fs').writeFileSync('inflight','ok'),250)`,`require('node:fs').writeFileSync('queued','ok')`];
 const code=policy==='raise'?`try:\n values=${parallelCode(commands,policy)}\nexcept ParallelError as error:\n rows=error.results\nelse:\n raise AssertionError("must fail")`:`rows=${parallelCode(commands,policy)}`;
 const result=await runtime.run(code+`\nassert not rows[0]["ok"] and rows[0]["error_code"]=="PROCESS_EXIT"\nassert "expected" in rows[0]["error"]\nassert rows[1]["ok"]`,context);
 assert.equal(result.isError,false,result.content[0].text);assert.equal(result.details.metrics.tool_failure_count,1);
 assert.equal(result.details.metrics.internal_tool_failures,1);assert.equal(result.details.scheduling.groups[0].state,'failed');
 assert.equal(calls.length,policy==='raise'?2:3);assert.equal(await fs.readFile(path.join(cwd,'inflight'),'utf8'),'ok');
 if(policy==='raise')await assert.rejects(fs.access(path.join(cwd,'queued')));
 assert.equal((await runtime.run('assert rows[2].get("skipped",False)=='+(policy==='raise'?'True':'False'),context)).isError,false);
}));

for(const transport of ['direct','rust'])test(`同一 parallel 混合原文读取和进程，别名复用仍受禁用检查 ${transport}`,()=>fixture(async({runtime,context,calls})=>{
 // 传输由 fixture 参数控制；两个 callable 共用同一调度通道。
 const readTool={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
 const mixed={tools:[tool,readTool],executeTool:async(name,args,options)=>name==='read'?{isError:false,result:{content:[{type:'text',text:'{"answer":42}'}]}}:context.executeTool(name,args,options)};
 const argv=JSON.stringify(job('console.log("ok")').argv);
 const result=await runtime.run(`alias=subprocess.run\nsource,checked=parallel([(read,{"path":"config.json"}),(alias,{"args":${argv},"check":True,"capture_output":True,"text":True})])\nassert json.loads(source)["answer"]==42 and checked.stdout.strip()=="ok"`,mixed);
 assert.equal(result.isError,false,result.content[0].text);assert.equal(result.details.metrics.batch_jobs,2);
 const disabled=await runtime.run(`parallel([(alias,{"args":${argv}})])`,{...mixed,tools:[readTool]});assert.equal(disabled.isError,true);assert.equal(calls.length,1);
},7000,transport));

test('并发进程保留 env 替换、cwd、反馈和 UTF-8，启动失败可收集',()=>fixture(async({runtime,cwd,context})=>{
 await fs.mkdir(path.join(cwd,'nested'));
 const args=JSON.stringify(job('console.log(JSON.stringify({mark:process.env.MARK,home:process.env.PIMOON_HOME,cwd:require("node:path").basename(process.cwd())}));console.error("诊断😀")').argv);
 const annotated={...context,executeTool:async(...args)=>{const outcome=await context.executeTool(...args);const data=outcome.result.structuredContent;return {...outcome,result:{content:[...outcome.result.content,{type:'text',text:'approval note'}],details:data}};}};
 const result=await runtime.run(`results=parallel([(subprocess.run,{"args":${args},"cwd":"nested","env":{"MARK":"isolated"},"capture_output":True,"text":True,"check":True})])\nassert json.loads(results[0].stdout)=={"mark":"isolated","cwd":"nested"}\nassert results[0].stderr.strip()=="诊断😀"\nrows=parallel([(subprocess.run,{"args":["missing-pimoon-executable"]})],errors="collect")\nassert rows[0]["error_code"]=="PROCESS_SPAWN_ERROR"`,annotated);
 assert.equal(result.isError,false,result.content[0].text);assert.match(result.content[0].text,/approval note/);assert.equal(result.details.metrics.tool_failure_count,1);
}));

test('check=False 非零退出仍返回结果；超时失败不重启 Python',()=>fixture(async({runtime,context})=>{
 const pid=runtime.workerInfo.pid,argv=JSON.stringify(job(`process.exit(7)`).argv),hang=JSON.stringify(job('setInterval(()=>{},1000)').argv);
 const result=await runtime.run(`saved=42\nvalues=parallel([(subprocess.run,{"args":${argv},"capture_output":True,"text":True})])\nassert values[0].returncode==7\nrows=parallel([(subprocess.run,{"args":${hang},"timeout":0.2})],errors="collect")\nassert rows[0]["error_code"]=="PROCESS_TIMEOUT"\nassert saved==42`,context);
 assert.equal(result.isError,false,result.content[0].text);assert.equal(result.details.metrics.tool_failure_count,1);
 assert.equal(runtime.workerInfo.pid,pid);
}));

test('进程任务参数先整组检查，禁用及被替换函数不获得调度资格',()=>fixture(async({runtime,context,calls})=>{
 for(const suffix of ['"timeout":-1','"capture_output":True','"env":{"X":1}','"check":"yes"']){
  const result=await runtime.run(`parallel([(subprocess.run,{"args":["node"]}),(subprocess.run,{"args":["node"],${suffix}})])`,context);
  assert.equal(result.isError,true);assert.equal(calls.length,0);
 }
 const disabled=await runtime.run('parallel([(subprocess.run,{"args":["node"]})])',{...context,tools:[]});assert.equal(disabled.isError,true);
 const rebound=await runtime.run('subprocess.run=lambda **kw: 1\nparallel([(subprocess.run,{"args":["node"]})])',context);assert.equal(rebound.isError,true);assert.equal(calls.length,0);
}));

test('取消并发组回收两个活动进程树且不派发第三项',()=>fixture(async({runtime,cwd,context,calls})=>{
 const controller=new AbortController();
 const commands=Array.from({length:3},(_,i)=>`require('node:fs').writeFileSync('pid-${i}',String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify("require('node:fs').writeFileSync('child-"+i+"',String(process.pid));setInterval(()=>{},1000)")}],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000)`);
 const pending=runtime.run(parallelCode(commands),context,controller.signal),rejected=assert.rejects(pending,/cancel/i);
 const until=Date.now()+3000;
 while(Date.now()<until){if((await fs.readdir(cwd)).filter(f=>f.startsWith('child-')).length===2)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal((await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')).length,2);assert.equal((await fs.readdir(cwd)).filter(f=>f.startsWith('child-')).length,2);
 controller.abort();await rejected;assert.equal(calls.length,2);assert.equal(runtime.hasState,false);
 for(const file of (await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')||f.startsWith('child-'))){const pid=Number(await fs.readFile(path.join(cwd,file),'utf8'));assert.throws(()=>process.kill(pid,0));}
}));

test('单个进程超时只中断依赖链，不清空 Python 变量或重启解释器',()=>fixture(async({runtime,context})=>{
 const pid=runtime.workerInfo.pid;
 const input=job('setInterval(()=>{},1000)',{timeout:0.3});
 const failed=await runtime.run(`saved=41\nsubprocess.run(**json.loads(${JSON.stringify(JSON.stringify({args:input.argv,timeout:input.timeout,check:true}))}))\nsaved=99`,context);
 assert.equal(failed.isError,true);assert.match(failed.content[0].text,/TimeoutExpired/);
 assert.equal(runtime.hasState,true);
 const next=await runtime.run('saved+=1\nassert saved==42\nsaved',context);
 assert.equal(next.isError,false,next.content[0].text);assert.equal(runtime.workerInfo.pid,pid);
}));

test('进程预算早于代码块截止，返回可捕获的错误而非清空状态',()=>fixture(async({runtime,context,calls})=>{
 const events=[],pid=runtime.workerInfo.pid;
 const input=job('setInterval(()=>{},1000)',{timeout:30});
 const failed=await runtime.run(`saved=42\nsubprocess.run(**json.loads(${JSON.stringify(JSON.stringify({args:input.argv,timeout:input.timeout,check:true}))}))`,context,undefined,1,(type,fields)=>events.push({type,...fields}));
 assert.equal(failed.isError,true);assert.match(failed.content[0].text,/TimeoutExpired/);
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
 const pending=runtime.run(`for args in json.loads(${JSON.stringify(JSON.stringify(jobs.map(job=>job.argv)))}):\n subprocess.run(args,check=True)`,context,controller.signal,1,(type,fields)=>events.push({type,...fields}));
 const rejected=assert.rejects(pending,/cancel/i);
 const until=Date.now()+3000;
 while(Date.now()<until){if((await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')).length===1)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal((await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')).length,1);
 controller.abort();await rejected;
 assert.equal(calls.length,1);assert.equal(events.filter(e=>e.type==='bridge_tool_start').length,1);
 assert.equal(events.some(e=>e.type==='runtime_state_lost'),true);assert.equal(runtime.hasState,false);
 for(const file of (await fs.readdir(cwd)).filter(f=>f.startsWith('pid-')||f.startsWith('child-'))){const pid=Number(await fs.readFile(path.join(cwd,file),'utf8'));assert.throws(()=>process.kill(pid,0));}
}));

for(const capture of [true,false])test(`subprocess.run UTF-8 输出、CompletedProcess 与默认流：capture=${capture}`,()=>fixture(async({runtime,context})=>{
 const args=job('console.log("原文😀");console.error("诊断")').argv;
 const code=`result=subprocess.run(${JSON.stringify(args)},capture_output=${capture?'True':'False'},text=True,check=True)\nassert result.returncode==0\n`+(capture?'assert result.stdout=="原文😀\\n" and result.stderr=="诊断\\n"\nresult':'assert result.stdout is None and result.stderr is None');
 const result=await runtime.run(code,context);assert.equal(result.isError,false,result.content[0].text);assert.match(result.content[0].text,/原文😀/);assert.match(result.content[0].text,/诊断/);
 assert.doesNotMatch(result.content[0].text,/process_run/);
}));
test('标准 check=False 保留退出码；check=True 抛 CalledProcessError 且保留状态',()=>fixture(async({runtime,context})=>{
 const args=job('console.log("out");console.error("err");process.exit(7)').argv;
 const result=await runtime.run(`saved=41\nr=subprocess.run(${JSON.stringify(args)},capture_output=True,text=True)\nassert r.returncode==7 and r.stdout.strip()=="out"\ntry:\n subprocess.run(${JSON.stringify(args)},capture_output=True,text=True,check=True)\nexcept subprocess.CalledProcessError as error:\n assert error.returncode==7 and error.stderr.strip()=="err"\nelse:\n raise AssertionError("expected error")\nassert saved==41`,context);
 assert.equal(result.isError,false,result.content[0].text);assert.equal(result.details.metrics.tool_failure_count,1);
}));
test('env 使用标准替换语义而非暗中继承，cwd 定位正确',()=>fixture(async({runtime,cwd,context})=>{
 await fs.mkdir(path.join(cwd,'nested'));
 const args=job('console.log(JSON.stringify({mark:process.env.MARK,home:process.env.PIMOON_HOME,cwd:require("node:path").basename(process.cwd())}))').argv;
 const result=await runtime.run(`result=subprocess.run(${JSON.stringify(args)},cwd="nested",env={"MARK":"isolated"},capture_output=True,text=True,check=True)\nassert json.loads(result.stdout)=={"mark":"isolated","cwd":"nested"}`,context);
 assert.equal(result.isError,false,result.content[0].text);
}));
test('拒绝 shell=True、命令字符串、Popen、二进制捕获及未支持选项，不能绕过桥接直接启动',()=>fixture(async({runtime,context,calls})=>{
 const cases=['subprocess.run("git status",shell=True)','subprocess.run(["git"],shell=True)','subprocess.run(["git"],capture_output=True)','subprocess.run(["git"],input="payload")','subprocess.Popen(["git"])'];
 for(const code of cases){const result=await runtime.run(code,context);assert.equal(result.isError,true,code);}
 assert.equal(calls.length,0);
}));
test('进程输出截断有明确标记，不把已完成进程误报为未执行',()=>fixture(async({runtime,context})=>{
 const result=await runtime.run(`r=subprocess.run(${JSON.stringify(job('process.stdout.write("x".repeat(70000))').argv)},capture_output=True,text=True,check=True)\nassert r.returncode==0 and "output truncated" in r.stderr\nlen(r.stdout)`,context);
 assert.equal(result.isError,false,result.content[0].text);assert.match(result.content[0].text,/65536/);
}));

for(const transport of ['direct','rust'])test(`encoding 覆盖和本地代码页检测经过真实桥接 ${transport}`,()=>fixture(async({runtime,context,calls})=>{
 const legacy=JSON.stringify(job('process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));process.stderr.write(Buffer.from([0xb4,0xed,0xce,0xf3]))').argv);
 const result=await runtime.run(`r=subprocess.run(${legacy},capture_output=True,encoding="cp936")\nassert r.stdout=="中文"\nassert r.stderr=="错误"`,context);
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(calls[0].encoding,'cp936');
 // 自动路径由运行时探测，不受 Python -X utf8 的首选编码影响。
 if(process.platform==='win32'){
  const native=await runtime.run('r=subprocess.run(["taskkill.exe","/?"],capture_output=True,text=True)\nassert r.returncode==0 and r.stdout and "�" not in r.stdout',context);
  assert.equal(native.isError,false,native.content[0].text);
  assert.ok(calls[1].fallback_encoding);
 }
},7000,transport));

test('串行解码失败可捕获原始字节，不重复进程副作用且保留 Python 状态',()=>fixture(async({runtime,cwd,context,calls})=>{
 const args=JSON.stringify(job('require("node:fs").appendFileSync("once","x");process.stdout.write(Buffer.from([0x81]));console.error("ok");process.exitCode=3').argv);
 const result=await runtime.run(`saved=42\ntry:\n subprocess.run(${args},capture_output=True,text=True,encoding="utf-8")\nexcept UnicodeError as error:\n assert error.stdout==bytes([0x81]) and error.stderr==b"ok\\n"\n assert error.returncode==3 and error.status=="exited"\nelse:\n raise AssertionError("decode should fail")\nassert saved==42`,context);
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.tool_failure_count,1);
 assert.equal(calls.length,1);assert.equal(await fs.readFile(path.join(cwd,'once'),'utf8'),'x');
}));

for(const policy of ['raise','collect'])test(`并发解码失败在宿主停止派发并保留字节 ${policy}`,()=>fixture(async({runtime,cwd,context,calls})=>{
 const jobs=[job('require("node:fs").appendFileSync("once","x");process.stdout.write(Buffer.from([0x81]))'),job('setTimeout(()=>console.log("ok"),300)'),job('require("node:fs").writeFileSync("queued","x")')].map(j=>({args:j.argv,capture_output:true,text:true,encoding:'utf-8'}));
 const run=`parallel([(subprocess.run,kw) for kw in json.loads(${JSON.stringify(JSON.stringify(jobs))})],errors=${JSON.stringify(policy)})`;
 const code=policy==='raise'?`try:\n ${run}\nexcept ParallelError as error:\n rows=error.results\nelse:\n raise AssertionError("decode should fail")`:`rows=${run}`;
 const result=await runtime.run(code+'\nassert rows[0]["error_code"]=="PROCESS_DECODE_ERROR"\nassert rows[0]["value"]["stdout_base64"]=="gQ=="\nassert rows[1]["ok"]',context);
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.tool_failure_count,1);
 assert.equal(result.details.metrics.internal_tool_failures,1);
 assert.equal(calls.length,policy==='raise'?2:3);
 assert.equal(await fs.readFile(path.join(cwd,'once'),'utf8'),'x');
 if(policy==='raise')await assert.rejects(fs.access(path.join(cwd,'queued')));
}));

test('DEVNULL 流不解码；未知编码启动前拒绝',()=>fixture(async({runtime,cwd,context})=>{
 const binary=JSON.stringify(job('process.stdout.write(Buffer.from([0x81]));console.error("ok")').argv);
 const marker=JSON.stringify(job('require("node:fs").writeFileSync("unexpected","x")').argv);
 const good=await runtime.run(`r=subprocess.run(${binary},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)\nassert r.stdout is None and r.stderr=="ok\\n"`,context);
 assert.equal(good.isError,false,good.content[0].text);
 const invalid=await runtime.run(`subprocess.run(${marker},encoding="not-a-codec")`,context);
 assert.equal(invalid.isError,true);assert.match(invalid.content[0].text,/Unsupported process encoding/);
 await assert.rejects(fs.access(path.join(cwd,'unexpected')));
}));

test('超时优先保留原始字节，串行与并发均不丢失非法输出',()=>fixture(async({runtime,context})=>{
 const args=JSON.stringify(job('process.stdout.write(Buffer.from([0x81]));setInterval(()=>{},1000)').argv);
 const result=await runtime.run(`try:\n subprocess.run(${args},capture_output=True,text=True,encoding="utf-8",timeout=0.3)\nexcept subprocess.TimeoutExpired as error:\n assert error.output==bytes([0x81])\nelse:\n raise AssertionError("timeout expected")\nrows=parallel([(subprocess.run,{"args":${args},"capture_output":True,"text":True,"encoding":"utf-8","timeout":0.3})],errors="collect")\nassert rows[0]["error_code"]=="PROCESS_TIMEOUT"\nassert rows[0]["value"]["stdout_base64"]=="gQ=="`,context);
 assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.tool_failure_count,2);
}));
