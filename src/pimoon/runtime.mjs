import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkReadablePath } from './paths.ts';
import { DEFAULT_PROCESS_TIMEOUT_SECONDS, limitProcessTimeout } from './codeact/process-budget.ts';

export const OP = { INIT:1, EXEC:2, REPLY:3, CANCEL:4, CLOSE:5, PING:6, NATIVE:7,
  READY:101, DONE:102, CALL:103, NATIVE_RESULT:107, PONG:108, ERROR:109, METRICS:110 };
const MAX_FRAME=8*1024*1024;
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
        if(size>MAX_FRAME)throw Error('Frame exceeds 8 MiB');
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
    this.rootPromise=fs.realpath(cwd);this.protectedPaths=protectedPaths;
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
    void this.rootPromise.catch(error=>{this.fail(error);this.close();});
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
  async nativeRead(data){
    const root=await this.rootPromise;
    const target=await checkReadablePath(root,new TextDecoder('utf8',{fatal:true}).decode(data),this.protectedPaths);
    const file=await fs.open(target,'r');
    try{
      const meta=await file.stat();if(!meta.isFile()||meta.size>4*1024*1024)throw Error('requires regular file <=4 MiB');
      const buffer=Buffer.allocUnsafe(Number(meta.size)+1);let total=0;
      while(total<buffer.length){const {bytesRead}=await file.read(buffer,total,buffer.length-total,null);if(!bytesRead)break;total+=bytesRead;}
      if(total>meta.size)throw Error('file changed while reading; retry only if appropriate');
      new TextDecoder('utf8',{fatal:true}).decode(buffer.subarray(0,total));
      return Buffer.concat([Buffer.from([1]),buffer.subarray(0,total)]);
    }finally{await file.close();}
  }
  async run(code,context,signal,session=1,onEvent=()=>{}){
    if(this.busy)throw Error('Host is busy; concurrent calls require separate host controllers');
    this.lastMetrics={outcome:this.dead?'runtime_crash':'runtime_error',metrics_complete:false};
    if(this.dead)throw Error('Runtime unavailable; state lost');
    this.busy=true;this.refs(true);
    const emit=(type,fields)=>{try{onEvent(type,fields);}catch{/* 遥测不能改变执行结果。 */}};
    const start=performance.now();let request,stopReason;const structuredFailures=[],images=[],callCounts=new Map();
    const toolController=new AbortController();
    let internalCalls=0,internalFailures=0,internalOutputChars=0,batches=0,stateLossObserved=false;
    const stateLost=(reason)=>{
      if(stateLossObserved)return;
      stateLossObserved=true;
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
    const invoke=async(name,args,batch)=>{
      const bridge=++internalCalls,bridgeId=randomUUID(),started=performance.now();let toolId,failed=true,chars=0;
      const tags={bridge_call_id:bridgeId,bridge_index:bridge,tool:name,...batch};
      emit('bridge_tool_start',tags);
      try{
        if(stopReason||signal?.aborted)throw Error('Cancelled');
        const tool=context.tools.find(t=>t.name===name);if(!tool)throw Error('Unknown tool: '+name);
        const remainingMs=this.timeoutMs-(performance.now()-start);
        const input=name==='process_run'?limitProcessTimeout(args,remainingMs):args;
        if(input!==args)emit('process_timeout_capped',{...tags,requested_seconds:args.timeout??DEFAULT_PROCESS_TIMEOUT_SECONDS,effective_seconds:input.timeout,remaining_ms:remainingMs});
        const outcome=await context.executeTool(name,input,{signal:toolController.signal});toolId=outcome.toolCall?.id;
        const content=outcome.result.content||[];
        // 图片不经 Python 字符串化，随父结果保留原始内容块。
        images.push(...content.filter(c=>c.type==='image'));
        const text=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
        failed=outcome.isError;chars=text.length;
        if(tool.outputSchema&&outcome.result.structuredContent!==undefined){
          if(failed)structuredFailures.push({tool:name,error:text.slice(0,600)||'structured tool failure'});
          return outcome.result.structuredContent;
        }
        if(failed)throw Error(text||`Tool ${name} failed`);return text;
      }finally{
        if(failed)internalFailures++;
        const count=callCounts.get(name)??{calls:0,errors:0};count.calls++;if(failed)count.errors++;callCounts.set(name,count);
        internalOutputChars+=chars;
        emit('bridge_tool_end',{...tags,tool_call_id:toolId,outcome:failed?'tool_error':'success',output_text_chars:chars,elapsed_ms:performance.now()-started});
      }
    };
    try{
      await this.ready;if(stopReason||signal?.aborted)throw Error('Cancelled');
      if(!this.sessions.has(session)){
        const started=performance.now(),previous=this.workerInfo?.pid;
        await this.createSession(session);
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
          const result=JSON.parse(frame.data);result.tool_failures.push(...structuredFailures);
          const summary=!result.output&&internalCalls?'\ncalls: '+[...callCounts].map(([name,count])=>`${name}=${count.calls}${count.errors?`(errors=${count.errors})`:''}`).join(' '):'';
          const text=`${result.ok?'ok':'error'}${result.output?'\n'+result.output:summary}${result.error?'\n'+result.error:''}${result.tool_failures.length?'\ntool_failures: '+JSON.stringify(result.tool_failures):''}${!result.output_complete?'\nOutput retention incomplete.':''}`;
          Object.assign(this.lastMetrics,result.metrics,{ok:result.ok,outcome:result.ok?(result.tool_failures.length?'tool_partial_failure':'success'):'python_error',metrics_complete:true,
            output_complete:result.output_complete,output_chars:result.output_chars,model_returned_text_chars:text.length,tool_failure_count:result.tool_failures.length});
          return {content:[{type:'text',text},...images],isError:!result.ok,details:{runtime:this.transport,metrics:this.lastMetrics}};
        }
        if(frame.op===OP.NATIVE){
          let data;try{data=await this.nativeRead(frame.data);}catch(error){data=Buffer.concat([Buffer.from([0]),Buffer.from(error.message)]);}
          this.send(OP.NATIVE_RESULT,session,request,data);continue;
        }
        if(frame.op!==OP.CALL)throw Error('Unexpected runtime frame');
        const message=JSON.parse(frame.data);
        try{
          let value;
          if(message.kind==='call')value=await invoke(message.name,message.args);
          else if(message.kind==='batch'){
            if(!['read','find','grep','ls','process_run'].includes(message.name))throw Error('batch name must be a tool: read/find/grep/ls/process_run, not a task label');
            if(!Array.isArray(message.jobs)||message.jobs.length>256||!Number.isInteger(message.limit)||message.limit<1||message.limit>16)throw Error('invalid batch bounds');
            if(message.name==='process_run'&&message.limit>4)throw Error('process_run batch concurrency limit must be <=4');
            if(message.jobs.some(job=>!job||typeof job!=='object'||Array.isArray(job)||'tool' in job||'args' in job))throw Error('batch jobs must be keyword-argument dicts for name, without tool/args wrappers');
            const batchId=randomUUID(),started=performance.now(),beforeFailures=internalFailures;
            batches++;
            emit('batch_start',{batch_id:batchId,tool:message.name,jobs:message.jobs.length,concurrency_limit:message.limit});
            value=Array(message.jobs.length);let cursor=0,active=0,peak=0,completed=0;
            try{
              await Promise.all(Array.from({length:Math.min(message.limit,value.length)},async()=>{
                while(cursor<value.length&&!stopReason&&!signal?.aborted){const index=cursor++;active++;peak=Math.max(peak,active);
                  try{value[index]={ok:true,value:await invoke(message.name,message.jobs[index],{batch_id:batchId,batch_index:index})};}
                  catch(error){value[index]={ok:false,error:error.message};}
                  finally{active--;completed++;}
                }
              }));
            }finally{
              emit('batch_end',{batch_id:batchId,tool:message.name,jobs:message.jobs.length,completed,failed:internalFailures-beforeFailures,peak_concurrency:peak,elapsed_ms:performance.now()-started,outcome:stopReason??(internalFailures>beforeFailures?'tool_failure':'success')});
            }
          }else throw Error('Unknown bridge operation');
          if(!stopReason)this.send(OP.REPLY,session,request,JSON.stringify({ok:true,value}));
        }catch(error){if(!stopReason)this.send(OP.REPLY,session,request,JSON.stringify({ok:false,error:error.message}));}
      }
    }catch(error){
      if(this.dead)stateLost('supervisor_exit');
      this.lastMetrics.outcome=stopReason??(signal?.aborted?'cancelled':request===undefined?'startup_error':this.dead||!this.sessions.has(session)?'runtime_crash':'runtime_error');
      this.lastMetrics.error_type=error.name;
      throw error;
    }finally{
      Object.assign(this.lastMetrics,{host_ms:performance.now()-start,internal_tool_calls:internalCalls,internal_tool_failures:internalFailures,internal_output_text_chars:internalOutputChars,batch_calls:batches});
      clearTimeout(timeout);signal?.removeEventListener('abort',cancel);this.busy=false;this.refs(false);
    }
  }
}
