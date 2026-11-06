import { afterEach, expect, it, vi } from "vitest";
import { SchedulingTrace } from "../../src/pimoon/scheduling.ts";
import { executionScheduling, estimatedSchedulingSavings } from "../../src/gui/shared/messages/scheduling.ts";
afterEach(() => vi.useRealTimers());
const jobs = [{name:"read",args:{path:"a.txt"}},{name:"read",args:{path:"b.txt"}}];
it("重叠按区间并集计算，空闲间隔不算加速",()=>{
 let time=0;const trace=new SchedulingTrace(undefined,()=>time),id=trace.begin(jobs,"raise");
 trace.observe(id,"start",0);time=10;trace.observe(id,"start",1);time=30;trace.observe(id,"end",0,true);time=50;trace.observe(id,"end",1,true);
 time=80;trace.end(id,[{ok:true},{ok:true}]);const result=trace.finish(false);
 expect(result.groups[0]).toMatchObject({peak:2,elapsedMs:80,overlapMs:20,state:"completed"});
 expect(result.groups[0]?.operations).toMatchObject([{startMs:0,durationMs:30,state:"ok"},{startMs:10,durationMs:40,state:"ok"}]);
 expect(executionScheduling({scheduling:result})).toEqual(result);
});
it("进程显示统一名称且不复制 argv 和环境到调度轨迹",()=>{
 const trace=new SchedulingTrace();const id=trace.begin([{name:"process_run",args:{argv:["C:/node/node.exe","--token","PRIVATE"],env:{KEY:"PRIVATE"}}}],"raise");
 trace.observe(id,"start",0);trace.observe(id,"end",0,true);trace.end(id,[{ok:true}]);
 const value=trace.finish(false);expect(value.groups[0]?.operations[0]).toMatchObject({name:"subprocess.run",target:"node.exe"});
 expect(JSON.stringify(value)).not.toContain("PRIVATE");expect(executionScheduling({scheduling:value})).toEqual(value);
});
it("显式组实际无重叠时不产生节省时间",()=>{
 let time=0;const trace=new SchedulingTrace(undefined,()=>time),id=trace.begin(jobs,"collect");
 trace.observe(id,"start",0);time=10;trace.observe(id,"end",0,true);time=30;trace.observe(id,"start",1);time=40;trace.observe(id,"end",1,true);
 trace.end(id,[{ok:true},{ok:true}]);expect(trace.finish(false).groups[0]).toMatchObject({peak:1,overlapMs:0,elapsedMs:40});
});
it("失败、未启动和取消不是完成，也不为中断计算收益",()=>{
 let time=0;const trace=new SchedulingTrace(undefined,()=>time),id=trace.begin(jobs,"raise");
 trace.observe(id,"start",0);time=10;trace.observe(id,"end",0,false);trace.end(id,[{ok:false},{ok:false,skipped:true}]);
 expect(trace.snapshot().groups[0]?.operations.map(x=>x.state)).toEqual(["error","skipped"]);
 const second=trace.begin(jobs,"raise");trace.observe(second,"start",0);time=30;
 const final=trace.finish(true);expect(final.state).toBe("interrupted");expect(final.groups[1]?.overlapMs).toBeUndefined();
 expect(final.groups[1]?.operations.map(x=>x.state)).toEqual(["interrupted","interrupted"]);
});
it("进度节流有尾部刷新，完成后不留计时器且旧快照不变",()=>{
 vi.useFakeTimers();let time=0;const update=vi.fn();const trace=new SchedulingTrace(update,()=>time),id=trace.begin(jobs,"raise");
 const before=trace.snapshot();trace.observe(id,"start",0);trace.observe(id,"start",1);expect(update).toHaveBeenCalledTimes(1);
 time=80;vi.advanceTimersByTime(80);expect(update).toHaveBeenCalledTimes(2);expect(before.groups[0]?.peak).toBe(0);
 expect(update.mock.lastCall?.[0].groups[0].peak).toBe(2);trace.finish(true);expect(vi.getTimerCount()).toBe(0);
});
it("轨迹有界，截断不改变总任务数，参数只投影目标",()=>{
 const trace=new SchedulingTrace();const many=Array.from({length:256},()=>({name:"read",args:{path:"x".repeat(300),secret:"PRIVATE_PAYLOAD"}}));
 for(let i=0;i<34;i++){const id=trace.begin(many,"collect");trace.end(id,[]);}
 const result=trace.finish(false);expect(result.groups).toHaveLength(32);expect(result.truncated).toBe(true);
 expect(result.groups.flatMap(x=>x.operations)).toHaveLength(256);expect(result.groups[0]?.total).toBe(256);
 expect(JSON.stringify(result)).not.toContain("PRIVATE_PAYLOAD");expect(executionScheduling({scheduling:result})).toBeDefined();
});
it("界面回调失败不影响采集，纯串行执行有明确空组记录",()=>{
 const trace=new SchedulingTrace(()=>{throw Error("UI unavailable");});expect(trace.finish(false)).toEqual({version:1,state:"completed",truncated:false,groups:[]});
});
it("未知旧记录和损坏数值不伪造时间线",()=>{
 expect(executionScheduling({metrics:{batch_calls:2}})).toBeUndefined();
 const trace=new SchedulingTrace(),id=trace.begin(jobs,"raise");trace.end(id,[]);const value=trace.finish(false);
 expect(executionScheduling({scheduling:{...value,version:9}})).toBeUndefined();
 expect(executionScheduling({scheduling:{...value,groups:value.groups.map(g=>({...g,elapsedMs:Infinity}))}})).toBeUndefined();
 expect(executionScheduling({scheduling:{...value,groups:[...value.groups,...value.groups]}})).toBeUndefined();
});

it("峰值超过六仍可展示，估算节省使用整个组墙钟而非区间重叠",()=>{
 let time=0;const trace=new SchedulingTrace(undefined,()=>time);
 const jobs=Array.from({length:10},()=>({name:"read",args:{path:"a"}}));
 const id=trace.begin(jobs,"collect");jobs.forEach((_,i)=>trace.observe(id,"start",i));
 time=1000;jobs.forEach((_,i)=>trace.observe(id,"end",i,true));
 time=1500;trace.end(id,jobs.map(()=>({ok:true})));const value=trace.finish(false);
 expect(executionScheduling({scheduling:value})?.groups[0]?.peak).toBe(10);
 expect(value.groups[0]?.overlapMs).toBe(9000);
 expect(estimatedSchedulingSavings(value)).toBe(8500);
 expect(executionScheduling({scheduling:{...value,groups:value.groups.map(g=>({...g,peak:11}))}})).toBeUndefined();
});
it("失败、运行中、截断和缺少计时不展示估算，调度开销不产生负节省",()=>{
 let time=0;const trace=new SchedulingTrace(undefined,()=>time),id=trace.begin(jobs,"collect");
 trace.observe(id,"start",0);trace.observe(id,"start",1);time=10;trace.observe(id,"end",0,true);trace.observe(id,"end",1,true);
 time=30;trace.end(id,[{ok:true},{ok:true}]);const value=trace.finish(false);
 expect(estimatedSchedulingSavings(value)).toBe(0);
 expect(estimatedSchedulingSavings({...value,state:"running"})).toBeUndefined();
 expect(estimatedSchedulingSavings({...value,truncated:true})).toBeUndefined();
 expect(estimatedSchedulingSavings({...value,groups:value.groups.map(g=>({...g,state:"failed"}))})).toBeUndefined();
 expect(estimatedSchedulingSavings({...value,groups:value.groups.map(g=>({...g,operations:g.operations.map(({durationMs: _duration,...op})=>op)}))})).toBeUndefined();
});
