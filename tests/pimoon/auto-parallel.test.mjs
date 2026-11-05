import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {scheduleReads} from '../../src/pimoon/scheduler.mjs';

const base=path.resolve('.tmp/tests/auto-parallel');
await fs.mkdir(base,{recursive:true});
const resources=await fs.mkdtemp(path.join(base,'resources-'));
await fs.mkdir(path.join(resources,'pimoon'));
for(const file of ['worker.py','process_api.py','auto_parallel.py','execution.py','feedback.py','observations.py','worker_hooks.py'])
 await fs.copyFile(path.join('src/pimoon',file),path.join(resources,'pimoon',file));
await fs.copyFile('assets/runtime/pimoon-runtime.exe',path.join(resources,'pimoon/pimoon-runtime.exe'));
process.env.PIMOON_RESOURCE_DIR=resources;
const {Runtime}=await import('../../src/pimoon/runtime.mjs');
const tools=['read','ls','find','grep','write','process_run'].map(name=>({name,parameters:{type:'object',properties:{path:{type:'string'},query:{type:'string'}}}}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(fn,{autoParallel=true,transport='direct',observe=false,delay=10,fail=null}={}){
 const cwd=await fs.mkdtemp(path.join(base,'case-'));
 const runtime=new Runtime({cwd,tools,autoParallel,transport,observe});
 let active=0,peak=0;const calls=[],events=[];
 const context={tools,executeTool:async(name,args)=>{
  calls.push([name,args]);active++;peak=Math.max(peak,active);
  try{await sleep(typeof delay==='function'?delay(args):delay);return {isError:args.path===fail,result:{content:[{type:'text',text:args.path===fail?'fixture failure':JSON.stringify({name,...args})}]}};}
  finally{active--;}
 }};
 const run=code=>runtime.run(code,context,undefined,1,(type,fields)=>events.push({type,...fields}));
 try{await runtime.ready;await fn({runtime,run,calls,events,peak:()=>peak});}
 finally{const exit=once(runtime.child,'exit');runtime.close();runtime.child.ref();await exit;}
}
for(const transport of ['direct','rust']){
 test(`${transport}: 混合只读工具自动并行，按源码次序赋值并跨轮保留`,()=>fixture(async({run,calls,events,peak})=>{
  const result=await run('a=read(path="a")\nb=ls(path="b")\nc=grep(query="c")\n[a,b,c]');
  assert.equal(result.isError,false,result.content[0].text);assert.equal(peak(),3);
  assert.deepEqual(calls.map(row=>row[0]),['read','ls','grep']);
  assert.equal(events.filter(e=>e.type==='schedule_start').length,1);
  assert.equal((await run('assert "a" in a and "b" in b and "c" in c')).isError,false);
  const cached=await run('a=read(path="a")\nb=ls(path="b")\nc=grep(query="c")\n[a,b,c]');
  assert.equal(cached.details.metrics.compile_cache_hit,true);assert.equal(calls.length,6);
 },{transport}));
}
test('显式关闭自动调度保持串行；并行与基线输出完全一致',async()=>{
 let expected;
 const code='a=read(path="a")\nb=read(path="b")\n[a,b]';
 await fixture(async({run,peak})=>{expected=(await run(code)).content;assert.equal(peak(),1);},{autoParallel:false});
 await fixture(async({run})=>assert.deepEqual((await run(code)).content,expected));
});
for(const [label,code,count] of [
 ['结果依赖','a=read(path="a")\nb=read(path=a)',2],
 ['动态参数调用','a=read(path=str("a"))\nb=read(path="b")',2],
 ['变量参数','p="a"\na=read(path=p)\nb=read(path="b")',2],
 ['写入屏障','a=read(path="a")\nwrite(path="middle")\nb=read(path="b")',3],
 ['控制流','if True:\n a=read(path="a")\n b=read(path="b")',2],
 ['循环','for p in ["a","b"]:\n a=read(path=p)',2],
 ['同目标覆盖','a=read(path="a")\na=read(path="b")',2],
 ['裸调用反馈','read(path="a")\nread(path="b")',2],
])test(label+'保持串行',()=>fixture(async({run,calls,peak})=>{
 const result=await run(code);assert.equal(result.isError,false,result.content[0].text);assert.equal(calls.length,count);assert.equal(peak(),1);
}));
test('被覆盖的工具退回原始 Python 调用，不调错代理',()=>fixture(async({run,calls,peak})=>{
 const result=await run('read=lambda **kw: "local"\na=read(path="a")\nb=ls(path="b")\nassert a=="local"');
 assert.equal(result.isError,false,result.content[0].text);assert.equal(calls.length,1);assert.equal(peak(),1);
}));
test('别名、动态代理不猜测并行；缺失名称保留前项执行',()=>fixture(async({run,calls})=>{
 assert.equal((await run('alias=read\na=alias(path="a")\nb=alias(path="b")')).isError,false);
 assert.equal(calls.length,2);
 const result=await run('del ls\na=read(path="a")\nb=ls(path="b")');
 assert.equal(result.isError,true);assert.match(result.content[0].text,/NameError/);assert.equal(calls.length,3);
}));
test('后项失败保留已赋值前项，原行号可见，不执行后续写入、不重放',()=>fixture(async({run,calls})=>{
 const result=await run('a=read(path="a")\nb=read(path="fail")\nwrite(path="never")');
 assert.equal(result.isError,true);assert.match(result.content[0].text,/line 2/);
 assert.deepEqual(calls.map(row=>row[1].path),['a','fail']);
 assert.equal((await run('assert "a" in a\nassert "b" not in globals()')).isError,false);
},{fail:'fail'}));
test('参数错误与重复关键字不被提前执行或绕过',()=>fixture(async({run,calls})=>{
 const syntax=await run('a=read(path="a",path="bad")\nb=read(path="b")');
 assert.equal(syntax.isError,true);assert.match(syntax.content[0].text,/SyntaxError/);assert.equal(calls.length,0);
 const dynamic=await run('a=read(path=missing)\nb=read(path="b")');
 assert.equal(dynamic.isError,true);assert.equal(calls.length,0);
}));
test('调度层拒绝写入、进程与无效作业',async()=>{
 for(const name of ['write','edit','process_run','http'])
  await assert.rejects(scheduleReads([{name,args:{}},{name:'read',args:{}}],()=>{throw Error('must not invoke');}),/Invalid read schedule/);
});
test('并发上限六，失败后停止继续派发，已发起读取正常排空',async()=>{
 let active=0,peak=0,started=0;
 const rows=await scheduleReads(Array.from({length:20},(_,i)=>({name:'read',args:{i}})),async(_name,{i})=>{
  started++;active++;peak=Math.max(peak,active);try{await sleep(i===0?1:20);if(i===0)throw Error('denied');return i;}finally{active--;}
 });
 assert.equal(peak,6);assert.equal(started,6);assert.equal(active,0);assert.equal(rows.length,20);assert.equal(rows[0].ok,false);
});
test('取消后不再启动后续作业',async()=>{
 let cancelled=false,started=0;
 await scheduleReads(Array.from({length:20},()=>({name:'read',args:{}})),async()=>{started++;cancelled=true;await sleep(1);return 'done';},()=>cancelled);
 assert.equal(started,1);
});

for(const expression of ['[read(path=p) for p in paths]','{p:read(path=p) for p in paths}', '[read(path="dir/"+p+".txt") for p in paths]', '[read(path=f"dir/{p}.txt") for p in paths]'])
 test('简单字符串推导式自动调度：'+expression,()=>fixture(async({run,events,calls,peak})=>{
  const result=await run('paths=["a","b","c"]\nvalues='+expression+'\nassert len(values)==3\nassert "p" not in globals()');
  assert.equal(result.isError,false,result.content[0].text);assert.equal(peak(),3);assert.equal(calls.length,3);assert.equal(events.filter(event=>event.type==='schedule_start').length,1);
 }));
for(const [label,source] of [
 ['自定义迭代','class Paths(list): pass\npaths=Paths(["a","b"])\nvalues=[read(path=p) for p in paths]'],
 ['自定义路径','class Name(str): pass\npaths=[Name("a"),Name("b")]\nvalues=[read(path=p) for p in paths]'],
 ['惰性迭代','paths=(p for p in ["a","b"])\nvalues=[read(path=p) for p in paths]'],
 ['带过滤','paths=["a","b"]\nvalues=[read(path=p) for p in paths if p]'],
 ['带转换','paths=["a","b"]\nvalues=[read(path=str(p)) for p in paths]'],
 ['包裹调用','paths=["a","b"]\nvalues=[str(read(path=p)) for p in paths]'],
 ['自定义字典键','paths=["a","b"]\nvalues={str(p):read(path=p) for p in paths}'],
])test(label+'推导式不猜测并行',()=>fixture(async({run,events,peak})=>{
 const result=await run(source);assert.equal(result.isError,false,result.content[0].text);assert.equal(peak(),1);assert.equal(events.filter(event=>event.type==='schedule_start').length,0);
}));
test('推导式工具被覆盖仍执行自定义函数，失败不会给结果变量赋值',()=>fixture(async({run,calls})=>{
 const custom=await run('paths=["a","b"]\nread=lambda **kw: "local"\nvalues=[read(path=p) for p in paths]\nassert values==["local","local"]');
 assert.equal(custom.isError,false,custom.content[0].text);assert.equal(calls.length,0);
 const failed=await run('paths=["a","fail","b"]\nvalues2=[read(path=p) for p in paths]');
 assert.equal(failed.isError,true);assert.equal((await run('assert "values2" not in globals()')).isError,false);
},{fail:'fail'}));

// 直接重放常见的 print(read/grep(...))，不要求模型先改成赋值。
for(const transport of ['direct','rust'])for(const observe of [false,true])
 test(`${transport}/observe=${observe}: 直接打印的读取并行，输出与串行逐字一致且缓存不重放`,async()=>{
  const code='print(read(path="slow"))\nprint(read(path="fast"))\nprint(grep(query="search"))\nprint(read(path="last"))';
  const options={transport,observe,delay:args=>args.path==='slow'?40:2};
  let expected;
  await fixture(async({run,peak})=>{
   const result=await run(code);assert.equal(result.isError,false,result.content[0].text);
   expected=result.content;assert.equal(peak(),1);
  },{...options,autoParallel:false});
  await fixture(async({run,calls,events,peak})=>{
   const result=await run(code);assert.equal(result.isError,false,result.content[0].text);
   assert.deepEqual(result.content,expected);assert.equal(peak(),4);
   assert.deepEqual(calls.map(row=>row[0]),['read','read','grep','read']);
   assert.equal(events.filter(event=>event.type==='schedule_start').length,1);
   const cached=await run(code);assert.deepEqual(cached.content,expected);
   assert.equal(cached.details.metrics.compile_cache_hit,true);assert.equal(calls.length,8);
  },options);
 });
test('打印与只读赋值混合调度，保留赋值结果和 print 返回值',()=>fixture(async({run,calls,peak})=>{
 const result=await run('a=read(path="a")\nprint(read(path="b"))\np=print(ls(path="c"))\nd=grep(query="d")\nassert p is None and "a" in a and "d" in d');
 assert.equal(result.isError,false,result.content[0].text);assert.equal(peak(),4);assert.equal(calls.length,4);
 assert.equal((await run('assert p is None and "a" in a and "d" in d')).isError,false);
}));
for(const [label,code,count] of [
 ['写入屏障','print(read(path="a"))\nwrite(path="middle")\nprint(read(path="b"))',3],
 ['动态参数','print(read(path=str("a")))\nprint(read(path="b"))',2],
 ['打印参数表达式','print(read(path="a"),end=str("!"))\nprint(read(path="b"))',2],
 ['输出文件','import io\nsink=io.StringIO()\nprint(read(path="a"),file=sink)\nprint(read(path="b"))',2],
 ['自定义 print','print=lambda value: write(path="side")\nprint(read(path="a"))\nprint(read(path="b"))',4],
 ['组内 print 赋值','print=read(path="a")\nb=read(path="b")',2],
 ['工具被覆盖','read=lambda **kw:"local"\nprint(read(path="a"))\nprint(ls(path="b"))',1],
 ['内置 print 替换','import builtins\noriginal=builtins.print\nbuiltins.print=lambda value: None\nprint(read(path="a"))\nprint(read(path="b"))\nbuiltins.print=original',2],
])test(label+'不跨越打印安全边界',()=>fixture(async({run,calls,events,peak})=>{
 const result=await run(code);assert.equal(result.isError,false,result.content[0].text);
 assert.equal(calls.length,count);assert.equal(peak(),1);assert.equal(events.filter(event=>event.type==='schedule_start').length,0);
}));
test('打印后项失败保留前项输出与行号，已派发读取排空但不打印后项、不启动写入',()=>fixture(async({run,calls,peak})=>{
 const result=await run('print(read(path="first"))\nprint(read(path="fail"))\nprint(read(path="tail"))\nwrite(path="never")');
 assert.equal(result.isError,true);assert.match(result.content[0].text,/line 2/);
 assert.match(result.content[0].text,/"path":"first"/);assert.doesNotMatch(result.content[0].text,/"path":"tail"/);
 assert.deepEqual(calls.map(row=>row[1].path),['first','fail','tail']);assert.equal(peak(),3);
},{fail:'fail'}));

test('编译缓存命中仍重新校验 print 绑定，跨轮覆盖后按串行原义执行',()=>fixture(async({run,calls,events})=>{
 const code='print(read(path="a"))\nprint(read(path="b"))';
 assert.equal((await run(code)).isError,false);
 assert.equal(events.filter(event=>event.type==='schedule_start').length,1);
 assert.equal((await run('print=lambda value: write(path="side")')).isError,false);
 const result=await run(code);assert.equal(result.isError,false,result.content[0].text);
 assert.equal(result.details.metrics.compile_cache_hit,true);
 assert.equal(events.filter(event=>event.type==='schedule_start').length,1);
 assert.deepEqual(calls.slice(2).map(row=>row[0]),['read','write','read','write']);
}));
