// 真实订阅烟测：只用合成工作区；窗口隐藏、禁用通知；不启用 JEV。
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const root = process.cwd();
const id = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
const run = path.join(root, '.tmp/tests/pimoon-desktop', id);
const home = path.join(root, '.private/pimoon-smoke', id);
const cwd = path.join(run, 'workspace');
await fs.mkdir(path.join(home, 'agent'), { recursive: true });
await fs.mkdir(cwd, { recursive: true });
const original = path.join('D:/Code/opi-agent-lab-20261103/.private/agent');
const raw = await fs.readFile(path.join(original, 'auth.json'));
const auth = JSON.parse(raw)['openai-codex'];
if (auth.type !== 'oauth' || auth.expires < Date.now() + 600_000) throw new Error('访问凭据过期或不足十分钟；不刷新、不替换模型。');
const credential = Object.fromEntries(['type', 'access', 'expires', 'accountId'].map(key => [key, auth[key]]));
credential.refresh = 'DISABLED_IN_PIMOON_COPY';
await fs.writeFile(path.join(home, 'agent/auth.json'), JSON.stringify({'openai-codex':credential}), { mode:0o600 });
const store = JSON.parse(await fs.readFile(path.join(original, 'models-store.json'), 'utf8'));
await fs.writeFile(path.join(home, 'agent/models-store.json'), JSON.stringify({'openai-codex':store['openai-codex']}), {mode:0o600});
await fs.writeFile(path.join(cwd, 'sample.txt'), 'pimoon synthetic sample\n');
const manifest = {id, home, cwd, model:'openai-codex/gpt-6-astra', jev:false, mode:process.argv.includes('--model')?'model':'inspect', auth_source_sha256:createHash('sha256').update(raw).digest('hex')};
await fs.writeFile(path.join(run, 'manifest.json'), JSON.stringify(manifest,null,2));
const env = {...process.env, PIMOON_HOME:home, PIMOON_WORKSPACE:cwd, PIMOON_HEADLESS:'1', HOME:home, USERPROFILE:home, APPDATA:path.join(home,'appdata'), LOCALAPPDATA:path.join(home,'localappdata')};
for(const folder of ['src','scripts'])await fs.cp(path.join(root,folder),path.join(run,'sources',folder),{recursive:true});
await fs.copyFile(new URL(import.meta.url),path.join(run,'pimoon-smoke.mjs'));
const hashes={};
for(const name of ['main.mjs','backend.mjs','preload.cjs','package.json','resources/pi/package.json','resources/pimoon/worker.py','resources/pimoon/pimoon-runtime.exe']) {
 const file=await fs.readFile(path.join(root,'dist/pimoon/resources/app',name));hashes[name]=createHash('sha256').update(file).digest('hex');
 const dest=path.join(run,'frozen-output',name);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,file);
}
await fs.writeFile(path.join(run,'app-hashes.json'),JSON.stringify(hashes,null,2));
delete env.ELECTRON_RUN_AS_NODE;
async function events(){
 const result=[];
 for(const dir of await fs.readdir(path.join(home,'telemetry')).catch(()=>[])) {
  for(const file of await fs.readdir(path.join(home,'telemetry',dir))) {
   if(!file.endsWith('.jsonl'))continue;
   const lines=(await fs.readFile(path.join(home,'telemetry',dir,file),'utf8')).split('\n').filter(Boolean);
   result.push(...lines.map(line=>JSON.parse(line)));
  }
 }
 return result;
}
async function wait(test, label, seconds=180){const until=Date.now()+seconds*1000;while(Date.now()<until){if(await test())return;await new Promise(resolve=>setTimeout(resolve,250));}throw Error('超时：'+label);}
let app = await electron.launch({executablePath:path.join(root,'dist/pimoon/pimoon.exe'),args:['--no-sandbox'],cwd,env,timeout:40000});
async function screenshot(file){const image=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));await fs.writeFile(path.join(run,file),Buffer.from(image,'base64'));}
let page;let report;const stderr=[];app.process().stderr.on('data',chunk=>stderr.push(chunk.toString()));
try {
 page=await app.firstWindow();await page.setViewportSize({width:1200,height:820});
 await page.getByRole('textbox',{name:'消息',exact:true}).waitFor({timeout:40000});
 await wait(async()=>Boolean(await page.evaluate(()=>sessionStorage.getItem('pimoon.session'))),'会话绑定',30);
 await wait(async()=>(await events()).some(e=>e.type==='session_start'),'自定义执行器扩展',30);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible())),false);
 await screenshot('initial.png');
 assert.match(await page.locator('body').innerText(),/pimoon/);
 assert.match(await page.locator('body').innerText(),/Dream/i);
 if(manifest.mode==='model') {
  async function turn(text){
   const count=(await events()).filter(e=>e.type==='agent_settled').length;
   await page.getByRole('textbox',{name:'消息',exact:true}).fill(text);
   await page.getByRole('textbox',{name:'消息',exact:true}).press('Control+Enter');
   await wait(async()=>(await events()).filter(e=>e.type==='agent_settled').length>count,'真实模型回复');
   await page.locator('.connection-status[data-state="就绪"]').first().waitFor({timeout:15000});
   const tail=(await events()).filter(e=>e.type==='model_end').at(-1);
   assert.ok(tail && tail.stop_reason!=='error','模型回复失败，保留本地会话与遥测供定位');
  }
  await turn('这是一次隔离合成烟测。请只执行一次 Python：pimoon_counter=41; pimoon_rows=list(range(1000)); print(pimoon_rows)。不要读取其他文件，不要使用 JavaScript。然后简短确认完成。');
  let codes=(await events()).filter(e=>e.type==='code_end');assert.equal(codes.length,1);assert.equal(codes[0].metrics.ok,true);assert.equal(codes[0].metrics.auto_observations,0);
  await turn('继续同一 Python 内存：把 pimoon_counter 加 1，断言它是42，pimoon_rows长度1000且总和499500。调用一次 read(path="sample.txt") 并打印结果，再 native_read("sample.txt")；捕获 native_read("missing.txt") 的错误，然后向 sys.stderr 写 synthetic-stderr。把 counter/count/total 写为 desktop-proof.json。不要重建原变量。简短确认。');
  const proof=JSON.parse(await fs.readFile(path.join(cwd,'desktop-proof.json'),'utf8'));assert.deepEqual(proof,{counter:42,count:1000,total:499500});
  codes=(await events()).filter(e=>e.type==='code_end');assert.equal(codes.at(-1).metrics.python_pid,codes[0].metrics.python_pid);assert.ok(codes.at(-1).metrics.stderr_chars>0);assert.ok(codes.at(-1).metrics.native_read_trace.some(e=>!e.ok));
  const previous=await page.evaluate(()=>sessionStorage.getItem('pimoon.session'));
  await page.evaluate(async()=>window.pimoon.send({action:'new'},sessionStorage.getItem('pimoon.session')));
  await page.waitForFunction(old=>sessionStorage.getItem('pimoon.session')!==old,previous);
  await turn('仅执行一次 Python，断言 "pimoon_counter" 不在 globals() 中。打印 isolated，然后中文简短确认新会话内存是独立的。');
  codes=(await events()).filter(e=>e.type==='code_end');assert.notEqual(codes.at(-1).metrics.python_pid,codes[0].metrics.python_pid);assert.notEqual(codes.at(-1).session_id,codes[0].session_id);
  assert.ok((await events()).some(e=>e.type==='tool_end'&&e.tool==='read'&&e.parent_tool_call_id));
  if(process.argv.includes('--restore')) {
   const firstSession=codes[0].session_id, oldPid=codes[0].metrics.python_pid;
   await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();});await app.close();
   app=await electron.launch({executablePath:path.join(root,'dist/pimoon/pimoon.exe'),args:['--no-sandbox'],cwd,env,timeout:40000});
   app.process().stderr.on('data',chunk=>stderr.push(chunk.toString()));
   page=await app.firstWindow();await page.setViewportSize({width:1200,height:820});
   await page.getByRole('textbox',{name:'消息',exact:true}).waitFor({timeout:40000});
   await page.evaluate(async id=>window.pimoon.send({action:'openSession',id},null),firstSession);
   await page.waitForFunction(id=>sessionStorage.getItem('pimoon.session')===id,firstSession);
   await turn('这是应用重启后的验收。不要重建变量，仅执行 assert "pimoon_counter" not in globals(); print("restart-fresh")。确认聊天历史可以恢复，但旧 Python 内存没有恢复。');
   const restored=(await events()).filter(e=>e.type==='code_end').at(-1);
   assert.equal(restored.session_id,firstSession);assert.equal(restored.metrics.ok,true);assert.notEqual(restored.metrics.python_pid,oldPid);
   assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,'desktop-proof.json'),'utf8')),proof);
  }
 }
 await screenshot('final.png');
 const all=await events();
 report={ok:true,...manifest,events:all.length,model_requests:all.filter(e=>e.type==='model_request').length,transports:all.filter(e=>e.type==='transport_start').length,code_calls:all.filter(e=>e.type==='code_end').length,reported_tokens:all.filter(e=>e.type==='model_end'&&e.usage_reported).reduce((n,e)=>n+e.usage.totalTokens,0),unknown_usage:all.filter(e=>e.type==='model_end'&&!e.usage_reported).length};
 if(manifest.mode==='inspect'){assert.equal(report.model_requests,0);assert.equal(report.transports,0);}
} catch(error){
 if(page){await fs.writeFile(path.join(run,'visible-error.txt'),await page.locator('body').innerText().catch(()=>''));await screenshot('failure.png').catch(()=>{});}
 await fs.writeFile(path.join(run,'failure.txt'),String(error.stack));console.error(JSON.stringify({ok:false,run,error:String(error)}));process.exitCode=1;
} finally {
 await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});
 await app.close();await fs.writeFile(path.join(run,'stderr.txt'),stderr.join(''));
 const pids=(await events()).filter(e=>e.type==='code_end').map(e=>e.metrics.python_pid).filter(Boolean);
 await wait(async()=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),'Python 子进程退出',10);
 if(report && !process.exitCode){report.cleanup_verified=true;await fs.writeFile(path.join(run,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,run,model_requests:report.model_requests,code_calls:report.code_calls}));}
 assert.equal(createHash('sha256').update(await fs.readFile(path.join(original,'auth.json'))).digest('hex'),manifest.auth_source_sha256);
}
