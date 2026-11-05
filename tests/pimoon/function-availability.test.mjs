import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Runtime } from '../../src/pimoon/runtime.mjs';

const base=path.resolve('.tmp/tests/function-availability');
await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));
await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','process_api.py','auto_parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py'])await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;

for(const transport of ['rust','direct'])test(`${transport}: 未启用的批次函数整块报错，重新启用后复用 Python 状态`,async()=>{
 const cwd=await fs.mkdtemp(path.join(base,'case-'));
 const tool={name:'process_run',outputSchema:{type:'object'},parameters:{type:'object',properties:{argv:{type:'array',items:{type:'string'}}}}};
 const read={name:'read',parameters:{type:'object',properties:{path:{type:'string'}}}};
 const runtime=new Runtime({transport,cwd,tools:[tool],observe:false});
 let calls=0;
 const context={tools:[read],executeTool:async()=>{calls++;return {isError:false,result:{content:[],structuredContent:{status:'exited',exit_code:0,stdout:'done',stderr:'',truncated:false}}};}};
 try{
  await runtime.ready;
  const denied=await runtime.run('saved=42\nsubprocess.run(["git","status","--short"])',context);
  assert.equal(denied.isError,true);
  assert.match(denied.content[0].text,/subprocess.run is not enabled/);
  assert.equal(calls,0);
  assert.equal(denied.details.metrics.batch_calls,0);
  assert.equal(denied.details.metrics.internal_tool_calls,0);
  const empty=await runtime.run('subprocess.run(["git","status"])',{...context,tools:[]});
  assert.equal(empty.isError,true);
  assert.match(empty.content[0].text,/subprocess.run is not enabled/);
  const enabled=await runtime.run('assert saved==42\nresult=subprocess.run(["git","status","--short"])\nassert result.returncode==0', {...context,tools:[tool]});
  assert.equal(enabled.isError,false,enabled.content[0].text);
  assert.equal(calls,1);
  assert.equal(enabled.details.metrics.python_pid,denied.details.metrics.python_pid);
 }finally{
  const exit=once(runtime.child,'exit');runtime.close();await exit;
 }
});
