import { spawn } from 'node:child_process';
import { scheduleJobs, processFailure, PROCESS_CONCURRENCY } from './scheduler.mjs';
import { SchedulingTrace } from './scheduling.ts';
import { isProcessResult } from './codeact/process.ts';
import { rawReadText } from './codeact/read-result.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROCESS_TIMEOUT_SECONDS, limitProcessTimeout } from './codeact/process-budget.ts';

export const OP = { INIT:1, EXEC:2, REPLY:3, CANCEL:4, CLOSE:5, PING:6,
  READY:101, DONE:102, CALL:103, PONG:108, ERROR:109, METRICS:110 };
const MAX_FRAME=20*1024*1024;
const ROOT=fileURLToPath(new URL('../../assets',import.meta.url));

export class Decoder {
  constructor(emit){this.emit=emit;this.header=Buffer.alloc(17);this.used=0;this.data=null;this.offset=0;}
  push(chunk){
    let offset=0;
    while(offset<chunk.length){
      if(!this.data){
        const n=Math.min(17-this.used,chunk.length-offset);
        chunk.copy(this.header,this.used,offset,offset+n);this.used+=n;offset+=n;
        if(this.used<17)continue;
        if(this.header.toString('ascii',0,4)!=='CA02')throw Error('Invalid protocol magic');
        const size=this.header.readUInt32LE(13);
        if(size>MAX_FRAME)throw Error('Frame exceeds 20 MiB');
        this.frame={op:this.header[4],session:this.header.readUInt32LE(5),request:this.header.readUInt32LE(9)};
        this.data=Buffer.allocUnsafe(size);this.offset=0;
      }
      const n=Math.min(this.data.length-this.offset,chunk.length-offset);
      chunk.copy(this.data,this.offset,offset,offset+n);this.offset+=n;offset+=n;
      if(this.offset===this.data.length){
        const frame={...this.frame,data:this.data};this.data=null;this.used=0;this.emit(frame);
      }
    }
  }
}

export class Runtime {
  constructor({transport='rust',observe=false,cwd,tools,timeoutMs=45000,protectedPaths=[]}){
    this.transport=transport;this.observe=observe;this.cwd=cwd;this.tools=tools;this.timeoutMs=timeoutMs;
    this.protectedPaths=protectedPaths;
    this.queue=[];this.waiters=[];this.request=0;this.sessions=new Set();this.statefulSessions=new Set();this.dead=false;this.closed=false;
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|PATHEXT|PIMOON_HOME|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(k)));
    const resources=process.env.PIMOON_RESOURCE_DIR || ROOT;
    const worker=path.join(resources,'pimoon','worker.py');
    const binary=path.join(resources,'pimoon/pimoon-runtime'+(process.platform==='win32'?'.exe':''));
    this.child=transport==='rust'?spawn(binary,[cwd,worker,'python'],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true}):
      spawn('python',['-X','utf8','-B',worker],{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.stderr='';
    const decoder=new Decoder(frame=>{const waiter=this.waiters.shift();if(waiter)waiter.resolve(frame);else this.queue.push(frame);});
    this.child.stdout.on('data',chunk=>{try{decoder.push(chunk);}catch(error){this.fail(error);this.close();}});
    this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-2000);});
    this.child.on('error',error=>this.fail(error));
    this.child.stdin.on('error',error=>this.fail(error));
    this.child.on('exit',()=>this.fail(Error('Runtime exited: '+this.stderr)));
    // 父进程关闭管道后，Rust 监督器释放其 Python 子进程。
    const startupTimeout=setTimeout(()=>{this.fail(Error('Runtime startup timed out'));this.close();},10000);
    startupTimeout.unref();
    this.ready=this.createSession(1).finally(()=>{clearTimeout(startupTimeout);if(!this.busy)this.refs(false);});
    // 后台预热允许无人等待；保留 ready 的拒绝状态供实际调用处理。
    void this.ready.catch(()=>{});
  }
  get hasState(){return !this.dead && this.statefulSessions.size > 0;}
  fail(error){this.dead=true;for(const waiter of this.waiters.splice(0))waiter.reject(error);}
  send(op,session,request,data=Buffer.alloc(0)){
    if(typeof data==='string')data=Buffer.from(data,'utf8');
    if(data.length>MAX_FRAME)throw Error('Frame too large');
    const header=Buffer.alloc(17);header.write('CA02');header[4]=op;
    header.writeUInt32LE(session,5);header.writeUInt32LE(request,9);header.writeUInt32LE(data.length,13);
    this.child.stdin.cork();this.child.stdin.write(header);this.child.stdin.write(data);this.child.stdin.uncork();
  }
  next(){
    if(this.queue.length)return Promise.resolve(this.queue.shift());
    if(this.dead)return Promise.reject(Error('Runtime unavailable; state lost'));
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
  refs(enabled){for(const item of [this.child,this.child.stdin,this.child.stdout,this.child.stderr])enabled?item.ref?.():item.unref?.();}
  async createSession(session){
    const request=++this.request;
    this.send(OP.INIT,session,request,JSON.stringify({observe:this.observe,protected_paths:this.protectedPaths,tools:this.tools.map(t=>({name:t.name,parameters:t.parameters}))}));
    const frame=await this.next();
    if(this.dead||frame.op!==OP.READY)throw Error(frame.data.toString()||'Runtime unavailable');
    this.sessions.add(session);this.workerInfo=JSON.parse(frame.data);
  }
  close(){
    if(this.closed)return;
    this.closed=true;
    if(!this.dead)this.send(OP.CLOSE,0,++this.request);
    this.child.stdin.end();
    this.fail(Error('Runtime closed; Python state lost'));
    this.refs(false);
  }
  async ping(){
    await this.ready;this.refs(true);
    try{const request=++this.request;this.send(OP.PING,0,request,'ping');const frame=await this.next();if(frame.op!==OP.PONG)throw Error('Bad ping');}
    finally{this.refs(false);}
  }
  async run(code,context,signal,session=1,onEvent=()=>{},onScheduling=()=>{}){
    if(this.busy)throw Error('Host is busy; concurrent calls require separate host controllers');
    this.lastMetrics={execution_metrics_version:1,outcome:this.dead?'runtime_crash':'runtime_error',metrics_complete:false,
      state_reused:this.hasState,state_lost:false,runtime_reinitialized:false};
    if(this.dead)throw Error('Runtime unavailable; state lost');
    this.busy=true;this.refs(true);
    const scheduling=new SchedulingTrace(onScheduling);this.lastScheduling=scheduling.snapshot();
    const emit=(type,fields)=>{try{onEvent(type,fields);}catch{/* 遥测不能改变执行结果。 */}};
    const start=performance.now();let request,stopReason;const attachments=[],callCounts=new Map();
    const toolController=new AbortController();
    let internalCalls=0,internalFailures=0,internalOutputChars=0,batches=0,batchJobs=0,batchCompleted=0,batchFailures=0,batchPeak=0,stateLossObserved=false;
    const stateLost=(reason)=>{
      if(stateLossObserved)return;
      stateLossObserved=true;this.lastMetrics.state_lost=true;
      emit('runtime_state_lost',{reason,python_pid:this.workerInfo?.pid,completed_writes_rolled_back:false});
    };
    const abort=(reason)=>{
      if(stopReason)return;
      stopReason=reason;
      toolController.abort();
      stateLost(reason);
      if(this.transport==='rust'){
        if(request){this.send(OP.CANCEL,session,request);this.sessions.delete(session);this.statefulSessions.delete(session);}
        else{this.fail(Error('cancelled during startup; Python state lost'));this.close();}
      }else{this.child.kill();this.fail(Error('cancelled; Python state lost; completed writes NOT rolled back'));}
    };
    const cancel=()=>abort('cancelled');
    signal?.addEventListener('abort',cancel,{once:true});
    const timeout=setTimeout(()=>abort('timeout'),this.timeoutMs);
    const invoke=async(name,args,batch,attachmentSink=attachments)=>{
      const bridge=++internalCalls,bridgeId=randomUUID(),started=performance.now();let toolId,failed=true,chars=0;
      const tags={bridge_call_id:bridgeId,bridge_index:bridge,tool:name,...batch};
      emit('bridge_tool_start',tags);
      try{
        if(stopReason||signal?.aborted)throw Error('Cancelled');
        const publicName=name==='process_run'?'subprocess.run':name;
        const tool=context.tools.find(t=>t.name===name);if(!tool)throw Error(`Function unavailable: ${publicName}. Enabled functions: ${context.tools.map(t=>t.name).join(', ')||'none'}. Check function permissions; do not bypass them.`);
        const remainingMs=this.timeoutMs-(performance.now()-start);
        const input=name==='process_run'?limitProcessTimeout(args,remainingMs):args;
        if(input!==args)emit('process_timeout_capped',{...tags,requested_seconds:args.timeout??DEFAULT_PROCESS_TIMEOUT_SECONDS,effective_seconds:input.timeout,remaining_ms:remainingMs});
        const outcome=await context.executeTool(name,input,{signal:toolController.signal});toolId=outcome.toolCall?.id;
        const content=outcome.result.content||[];
        // 图片不经 Python 字符串化，随父结果保留原始内容块。
        attachmentSink.push(...content.filter(c=>c.type==='image'));
        const text=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
        failed=outcome.isError;chars=text.length;
        // 审批反馈可能使 SDK 撤销结构化文本；进程数据取执行器 details，反馈独立回传。
        if(name==='process_run'&&!failed){
          const result=isProcessResult(outcome.result.details)?outcome.result.details:outcome.result.structuredContent;
          if(batch)failed=Boolean(processFailure(result,batch.process_check));
          if(isProcessResult(result))return {...result,timeout:input.timeout??DEFAULT_PROCESS_TIMEOUT_SECONDS,feedback:content.slice(1).filter(c=>c.type==='text').map(c=>c.text).join('\n')};
          failed=true;throw Error('Invalid process result; do not replay completed operations');
        }
        if(failed){
          const detail=outcome.result.details;
          const code=detail?.status==='failed'&&typeof detail.error?.code==='string'?detail.error.code:'TOOL_ERROR';
          throw Object.assign(Error(text||`Tool ${name} failed`),{code});
        }
        // 审批备注不进入待解析的原文，也不丢弃；结果被替换时不恢复旧正文。
        const raw=name==='read'&&args.mode==='raw'?rawReadText(outcome.result.details):undefined;
        if(raw!==undefined&&content[0]?.type==='text'&&content[0].text===raw){
          attachmentSink.push(...content.slice(1).filter(c=>c.type==='text'));
          return raw;
        }
        if(tool.outputSchema&&outcome.result.structuredContent!==undefined)return outcome.result.structuredContent;
        return text;
      }finally{
        if(failed)internalFailures++;
        const count=callCounts.get(name==='process_run'?'subprocess.run':name)??{calls:0,errors:0};count.calls++;if(failed)count.errors++;callCounts.set(name==='process_run'?'subprocess.run':name,count);
        internalOutputChars+=chars;
        emit('bridge_tool_end',{...tags,tool_call_id:toolId,outcome:failed?'tool_error':'success',output_text_chars:chars,elapsed_ms:performance.now()-started});
      }
    };
    try{
      const waiting=performance.now();
      try{await this.ready;}finally{this.lastMetrics.startup_wait_ms=performance.now()-waiting;}
      if(stopReason||signal?.aborted)throw Error('Cancelled');
      if(!this.sessions.has(session)){
        const started=performance.now(),previous=this.workerInfo?.pid;
        await this.createSession(session);
        this.lastMetrics.runtime_reinitialized=true;this.lastMetrics.state_reused=false;
        emit('runtime_reinitialized',{previous_python_pid:previous,python_pid:this.workerInfo?.pid,python_version:this.workerInfo?.python_version,startup_ms:performance.now()-started,state_restored:false});
      }
      request=++this.request;this.send(OP.EXEC,session,request,JSON.stringify({code,tools:context.tools.map(t=>({name:t.name,parameters:t.parameters}))}));this.statefulSessions.add(session);
      while(true){
        const frame=await this.next();
        if(frame.request!==request||frame.session!==session)continue; // 忽略取消后残留的旧帧。
        if(frame.op===OP.ERROR){
          this.sessions.delete(session);this.statefulSessions.delete(session);
          if(!stopReason)stateLost(/worker exited/i.test(frame.data.toString())?'worker_exit':'runtime_error');
          throw Error(frame.data.toString());
        }
        if(frame.op===OP.METRICS){Object.assign(this.lastMetrics,JSON.parse(frame.data));continue;}
        if(frame.op===OP.DONE){
          const result=JSON.parse(frame.data);
          const summary=!result.output&&internalCalls?'\ncalls: '+[...callCounts].map(([name,count])=>`${name}=${count.calls}${count.errors?`(errors=${count.errors})`:''}`).join(' '):'';
          const text=`${result.ok?(result.tool_failures.length?'partial_failure':'ok'):'error'}${result.output?'\n'+result.output:summary}${result.error?'\n'+result.error:''}${result.tool_failures.length?'\ntool_failures: '+JSON.stringify(result.tool_failures):''}${!result.output_complete?'\nOutput retention incomplete.':''}`;
          Object.assign(this.lastMetrics,result.metrics,{ok:result.ok,outcome:result.ok?(result.tool_failures.length?'tool_partial_failure':'success'):'python_error',metrics_complete:true,
            output_complete:result.output_complete,output_chars:result.output_chars,model_returned_text_chars:text.length+attachments.filter(c=>c.type==='text').reduce((sum,c)=>sum+c.text.length,0),tool_failure_count:result.tool_failures.length});
          return {content:[{type:'text',text},...attachments],isError:!result.ok,details:{runtime:this.transport,metrics:this.lastMetrics,scheduling:this.lastScheduling=scheduling.finish(false)}};
        }
        if(frame.op!==OP.CALL)throw Error('Unexpected runtime frame');
        const message=JSON.parse(frame.data);
        try{
          let value;
          if(message.kind==='call')value=await invoke(message.name,message.args);
          else if(message.kind==='schedule'){
            const started=performance.now(),scheduleId=randomUUID(),media=[];
            const group=Array.isArray(message.jobs)&&message.jobs.every(job=>job&&typeof job.name==='string'&&job.args&&typeof job.args==='object')
              ? scheduling.begin(message.jobs,message.errors==='collect'?'collect':'raise'):undefined;
            let active=0,peak=0,completed=0;
            const beforeFailures=internalFailures; batches++; batchJobs+=message.jobs?.length??0;
            emit('schedule_start',{schedule_id:scheduleId,jobs:message.jobs?.length,concurrency_limit:null,process_concurrency_limit:PROCESS_CONCURRENCY,mode:'explicit',error_policy:message.errors});
            try{
              value=await scheduleJobs(message.jobs,(name,args,index)=>{
                const blocks=[];media[index]=blocks;
                return invoke(name,args,{schedule_id:scheduleId,schedule_index:index,process_check:message.jobs[index].check},blocks);
              },()=>Boolean(stopReason||signal?.aborted),(stage,index,row)=>{
                if(group!==undefined)scheduling.observe(group,stage,index,row?.ok);
                if(stage==='start'){active++;peak=Math.max(peak,active);}else{active--;completed++;}
              },message.errors);
            }finally{
              if(group!==undefined)scheduling.end(group,value??[],Boolean(stopReason||signal?.aborted));
              // 图片和备注按源码次序返回，不能随完成次序错配。
              for(const blocks of media)if(blocks)attachments.push(...blocks);
              batchCompleted+=completed;batchFailures+=internalFailures-beforeFailures;batchPeak=Math.max(batchPeak,peak);
            }
            emit('schedule_end',{schedule_id:scheduleId,jobs:value.length,completed,peak_concurrency:peak,failed:internalFailures-beforeFailures,skipped:value.filter(row=>row.skipped).length,elapsed_ms:performance.now()-started});
          }
          else throw Error('Unknown bridge operation');
          if(!stopReason){
            const reply=JSON.stringify({ok:true,value});
            if(Buffer.byteLength(reply)>MAX_FRAME)throw Object.assign(Error('Tool reply exceeds 20 MiB; request less content or smaller read groups. Completed calls were not rolled back.'),{code:'RESULT_TOO_LARGE'});
            this.send(OP.REPLY,session,request,reply);
          }
        }catch(error){if(!stopReason)this.send(OP.REPLY,session,request,JSON.stringify({ok:false,error:error.message,error_code:typeof error.code==='string'?error.code:'TOOL_ERROR'}));}
      }
    }catch(error){
      if(this.dead)stateLost('supervisor_exit');
      this.lastMetrics.outcome=stopReason??(signal?.aborted?'cancelled':request===undefined?'startup_error':this.dead||!this.sessions.has(session)?'runtime_crash':'runtime_error');
      this.lastMetrics.error_type=error.name;
      this.lastScheduling=scheduling.finish(true);
      throw error;
    }finally{
      Object.assign(this.lastMetrics,{host_ms:performance.now()-start,internal_tool_calls:internalCalls,internal_tool_failures:internalFailures,internal_output_text_chars:internalOutputChars,
        batch_calls:batches,batch_jobs:batchJobs,batch_completed:batchCompleted,batch_failures:batchFailures,batch_peak_concurrency:batchPeak});
      clearTimeout(timeout);signal?.removeEventListener('abort',cancel);this.busy=false;this.refs(false);
    }
  }
}
