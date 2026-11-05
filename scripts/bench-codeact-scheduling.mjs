// 显式 live 才读订阅，凭据只经 stdin 传入隔离子进程，禁止刷新和写源配置。
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {scenarios} from './benchmark/scheduling-scenarios.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),option=(name,fallback)=>args.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
if(args.includes('--help')){console.log('node scripts/bench-codeact-scheduling.mjs --live --source-home=PATH --resources=PATH [--runs=1] [--scenarios=independent-review,locate-edit,conditional-edit]');process.exit(0);}
if(!args.includes('--live'))throw Error('需要显式 --live');
const source=option('source-home'),resourceSource=option('resources');
if(!source||!resourceSource)throw Error('需要显式只读 source-home 和 resources；不搜索其他用户目录');
const runs=Number(option('runs','1')),selected=option('scenarios',Object.keys(scenarios).join(',')).split(',');
if(!Number.isInteger(runs)||runs<1||runs>3||selected.some(name=>!Object.hasOwn(scenarios,name)))throw Error('无效运行轮数或场景');
const authPath=path.join(source,'agent/auth.json'),original=await fs.readFile(authPath);
const credential=JSON.parse(original)['openai-codex'];
if(credential?.type!=='oauth'||credential.expires<Date.now()+600000)throw Error('订阅有效期不足十分钟；不刷新');
const accessOnly=Object.fromEntries(['type','access','expires','accountId'].map(key=>[key,credential[key]]));
accessOnly.refresh='DISABLED_IN_SCHEDULING_BENCHMARK';
const catalog=JSON.parse(await fs.readFile(path.join(source,'agent/models-store.json'),'utf8'));
const model=option('model','gpt-6.1-sol');
const parent=path.join(root,'.tmp/tests/scheduling-live');await fs.mkdir(parent,{recursive:true});
const base=await fs.mkdtemp(path.join(parent,'run-'));
const resources=path.join(base,'resources');await fs.cp(resourceSource,resources,{recursive:true});
for(const file of ['worker.py','process_api.py','auto_parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py'])await fs.copyFile(path.join(root,'src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile(path.join(root,'assets/runtime/pimoon-runtime.exe'),path.join(resources,'pimoon/pimoon-runtime.exe'));
const hash=data=>createHash('sha256').update(data).digest('hex');
const manifest={createdAt:new Date().toISOString(),model,thinking:'low',transport:'sse',runs,scenarios:selected,sourceAuthUnchanged:null,
 variants:{A:'standard Python interface, serial reads',B:'same interface, automatic read scheduling'},sources:{}};
const bundles={};
for(const variant of ['A','B']){
 const bundle=path.join(base,variant+'.mjs');let runtimePatched=false;
 const plugins=[{name:'scheduling-comparison',setup(builder){
  builder.onLoad({filter:/[\\/]pimoon[\\/]runtime\.mjs$/},async({path:file})=>{
   const text=await fs.readFile(file,'utf8'),before='autoParallel=true';
   if(text.split(before).length!==2)throw Error('执行器开关定位失败');
   runtimePatched=true;return{contents:text.replace(before,'autoParallel='+String(variant==='B')),loader:'js'};
  });
 }}];
 const entry=`export {default as fileTools} from ${JSON.stringify(path.join(root,'src/harness/extensions/file-tools.ts'))};
export {default as systemPrompt} from ${JSON.stringify(path.join(root,'src/harness/extensions/system-prompt.ts'))};
export {default as processFunctions} from ${JSON.stringify(path.join(root,'src/harness/extensions/codeact-functions.ts'))};
export {CodeAct} from ${JSON.stringify(path.join(root,'src/pimoon/codeact/session.ts'))};
export {flushTelemetry} from ${JSON.stringify(path.join(root,'src/pimoon/telemetry.ts'))};
export {estimateRequestTokens,estimateResponseTokens,summarizeTokenAccounting,textTokens} from ${JSON.stringify(path.join(root,'src/pimoon/token-accounting.ts'))};
export {responseUsageStatus} from ${JSON.stringify(path.join(root,'src/pimoon/usage-status.ts'))};
export {scenarios} from ${JSON.stringify(path.join(root,'scripts/benchmark/scheduling-scenarios.mjs'))};
export async function disposeLsp(){const {lspManager}=await import(${JSON.stringify(path.join(root,'src/harness/lsp/index.ts'))});await lspManager.reload();}`;
 const built=await build({stdin:{contents:entry,resolveDir:root},outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external',plugins,metafile:true,logLevel:'silent'});
 if(!runtimePatched)throw Error('候选注入未实际生效，拒绝无效 A/B');
 manifest.variants[variant]={description:manifest.variants[variant],runtimePatched};
 bundles[variant]=bundle;
 for(const file of Object.keys(built.metafile.inputs))if(file!=='<stdin>')manifest.sources[file]=hash(await fs.readFile(path.resolve(root,file)));
}
const results=[];
async function telemetry(home){
 const rows=[];
 async function visit(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(()=>[])){
  const file=path.join(directory,entry.name);if(entry.isDirectory())await visit(file);else if(entry.name.endsWith('.jsonl'))for(const line of (await fs.readFile(file,'utf8')).trim().split('\n'))if(line)rows.push(JSON.parse(line));
 }}
 await visit(path.join(home,'pimoon_home','telemetry'));
 const schedules=rows.filter(row=>row.type==='schedule_start'),calls=rows.filter(row=>row.type==='bridge_tool_start'),code=rows.filter(row=>row.type==='code_end');
 return{explicitBatchCalls:rows.filter(row=>row.type==='batch_start').length,scheduleCalls:schedules.length,scheduledJobs:schedules.reduce((sum,row)=>sum+row.jobs,0),hostCalls:calls.length,scheduledHostCalls:calls.filter(row=>row.schedule_id).length,
  nativeReads:code.reduce((sum,row)=>sum+(row.metrics?.native_read_calls_observed??0),0),scheduledNativeReads:rows.filter(row=>row.type==='scheduled_native_read').length,
  codeBlocks:code.length,executionHostMs:code.reduce((sum,row)=>sum+(row.metrics?.host_ms??0),0)};
}
try{
 for(let round=0;round<runs;round++)for(const scenario of selected)for(const variant of ((round+selected.indexOf(scenario))%2?['B','A']:['A','B'])){
  const home=path.join(base,`${round}-${scenario}-${variant}`),env={...process.env,PIMOON_RESOURCE_DIR:resources,PI_OPI_RESOURCE_DIR:resources,PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of ['PIMOON_HOME','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP']){env[key]=path.join(home,key.toLowerCase());await fs.mkdir(env[key],{recursive:true});}
  env.PI_CODING_AGENT_DIR=env.PIMOON_CODING_AGENT_DIR=path.join(env.PIMOON_HOME,'agent');
  console.log(`Running ${variant} ${scenario} round=${round+1}`);
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(root,'scripts/workers/bench-live-tools-worker.mjs'),'pimoon',bundles[variant],home,scenario,model,'low','sse','runtime'],{cwd:root,env,windowsHide:true,timeout:240000,stdio:['pipe','pipe','pipe']});
   let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4000);});
   child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(Error(`子进程失败 ${code}: ${stderr}`));try{resolve(JSON.parse(stdout.trim().split('\n').at(-1)));}catch{reject(Error('子进程未返回有效结果'));}});
   child.stdin.on('error',reject);child.stdin.end(JSON.stringify({credential:accessOnly,catalog:{'openai-codex':catalog['openai-codex']}}));
  });
  const row={round:round+1,variant,...result,scheduling:await telemetry(home)};results.push(row);
  await fs.writeFile(path.join(base,'results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({round:row.round,variant,scenario,ok:row.ok,failure:row.failure,elapsedMs:row.elapsedMs,toolMs:row.toolMs,requests:row.requests,incompleteUsage:row.incompleteUsage,scheduling:row.scheduling}));
 }
}finally{
 manifest.sourceAuthUnchanged=hash(original)===hash(await fs.readFile(authPath));
 await fs.writeFile(path.join(base,'manifest.json'),JSON.stringify(manifest,null,2));
}
console.log('Results: '+base);
if(results.some(row=>!row.ok))process.exitCode=1;
