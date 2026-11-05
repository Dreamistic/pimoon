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
for(const file of ['worker.py','process_api.py','auto_parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py']) await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
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
 for(const file of (await fs.readdir(cwd)).filter(f=>f.startsWith('pid-'))){const pid=Number(await fs.readFile(path.join(cwd,file),'utf8'));assert.throws(()=>process.kill(pid,0));}
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
test('拒绝 Shell、Popen、二进制捕获及未支持选项，不能绕过桥接直接启动',()=>fixture(async({runtime,context,calls})=>{
 const cases=['subprocess.run("git status",shell=True)','subprocess.run(["git"],shell=True)','subprocess.run(["git"],capture_output=True)','subprocess.run(["git"],input="payload")','subprocess.Popen(["git"])'];
 for(const code of cases){const result=await runtime.run(code,context);assert.equal(result.isError,true,code);}
 assert.equal(calls.length,0);
}));
test('进程输出截断有明确标记，不把已完成进程误报为未执行',()=>fixture(async({runtime,context})=>{
 const result=await runtime.run(`r=subprocess.run(${JSON.stringify(job('process.stdout.write("x".repeat(70000))').argv)},capture_output=True,text=True,check=True)\nassert r.returncode==0 and "output truncated" in r.stderr\nlen(r.stdout)`,context);
 assert.equal(result.isError,false,result.content[0].text);assert.match(result.content[0].text,/65536/);
}));
