// 成品无窗口验证：仅合成 OAuth、本地网络夹具与隔离目录，不读取真实凭据。
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
const base = process.argv[2], app = process.argv[3];
if(!base||!app)throw Error("Usage: node scripts/smoke-codeact-artifact.mjs TEST_DIR APP_DIR");
const code="from pathlib import Path\nassert \"native_read\" not in globals() and \"batch\" not in globals() and \"process_run\" not in globals()\nassert not hasattr(functions,\"process_run\")\na,b=parallel([(read,{\"path\":\"a.txt\"}),(read,{\"path\":\"b.txt\"})])\nassert \"alpha\" in a and \"beta\" in b\nassert read(path=\"a.txt\",mode=\"raw\")==\"alpha\"\nserial_a=read(path=\"a.txt\")\nserial_b=read(path=\"b.txt\")\nassert serial_a==a and serial_b==b\nrows=parallel([(read,{\"path\":\"missing-raw.txt\",\"mode\":\"raw\"}),(read,{\"path\":\"missing-tool.txt\"})],errors=\"collect\")\nassert [r[\"error_code\"] for r in rows]==[\"FILE_NOT_FOUND\",\"FILE_NOT_FOUND\"]\ntry:\n read(path=\"missing-single.txt\")\nexcept ToolError as error:\n assert error.code==\"FILE_NOT_FOUND\"\nresult=subprocess.run([\"node\", \"-e\", \"require(\\\"node:fs\\\").appendFileSync(\\\"packaged.txt\\\",\\\"once\\\");console.log(42)\"],capture_output=True,text=True,check=True)\nassert result.returncode==0 and result.stdout.strip()==\"42\"\nnonzero=subprocess.run([\"node\", \"-e\", \"process.exit(7)\"],capture_output=True,text=True)\nassert nonzero.returncode==7\nPath(\"proof.json\").write_text(json.dumps({\"returncode\":result.returncode,\"failed_returncode\":nonzero.returncode,\"reads\":5,\"missing_codes\":[r[\"error_code\"] for r in rows]}),encoding=\"utf-8\")\n{\"complete\":True}\n";
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_SUBAGENT_CHILD: "1", PI_OFFLINE: "1", PIMOON_NO_NOTIFICATIONS: "1" };
for (const key of ["PIMOON_HOME","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","TEMP","TMP"]) {
    env[key] = path.join(base, "smoke", key.toLowerCase()); await fs.mkdir(env[key], {recursive:true});
}
const cwd = path.join(base,"smoke","workspace"); await fs.mkdir(cwd,{recursive:true});
const agent = path.join(env.PIMOON_HOME,"agent"); await fs.mkdir(agent,{recursive:true});
await fs.writeFile(path.join(cwd,"a.txt"),"alpha");await fs.writeFile(path.join(cwd,"b.txt"),"beta");
// 这里只验证成品桥接；审批授权的暂停/拒绝由开启审批的 SDK 用例覆盖。
env.PI_APPROVAL_GATE_CONFIG=path.join(base,"smoke-approval.jsonc");
await fs.writeFile(env.PI_APPROVAL_GATE_CONFIG,'{"enabled":false}');
let requests=0, declarations=[];
const server=createServer(async(req,res)=>{
    const chunks=[]; for await(const c of req) chunks.push(c);
    const raw=Buffer.concat(chunks); const body=JSON.parse((req.headers["content-encoding"]==="zstd"?zstdDecompressSync(raw):raw).toString());
    if(!Array.isArray(body.input)){res.writeHead(400).end();return;}
    requests++;
    const tools=[...(body.tools??[]),...(body.input??[]).flatMap(item=>item.tools??[])];
    declarations.push(tools.map(tool=>tool.name));
    const descriptions=JSON.stringify(tools);
    if(!descriptions.includes("subprocess.run")||descriptions.includes("process_run(")||descriptions.includes("batch("))throw Error("Packaged model interface was not simplified");
    res.writeHead(200,{"content-type":"text/event-stream"});
    const send=x=>res.write(`data: ${JSON.stringify(x)}\n\n`);
    send({type:"response.created",response:{id:`response-${requests}`}});
    if(requests===1){
      const item={type:"function_call",id:"item-1",call_id:"packaged-call",name:"execute"};
      const args=JSON.stringify({code,desc:"成品统一接口验证"});
      send({type:"response.output_item.added",output_index:0,item:{...item,arguments:""}});
      send({type:"response.function_call_arguments.delta",output_index:0,item_id:"item-1",delta:args});
      send({type:"response.output_item.done",output_index:0,item:{...item,arguments:args}});
    }else{
      send({type:"response.output_item.added",output_index:0,item:{type:"message",id:"answer",role:"assistant",content:[]}});
      send({type:"response.output_text.delta",output_index:0,content_index:0,delta:"packaged complete"});
      send({type:"response.output_item.done",output_index:0,item:{type:"message",id:"answer",role:"assistant",content:[{type:"output_text",text:"packaged complete"}]}});
    }
    send({type:"response.completed",response:{id:`response-${requests}`,status:"completed",output:[],usage:{input_tokens:12,output_tokens:2,total_tokens:14}}});
    res.end();
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address(); const url=`http://127.0.0.1:${address.port}/v1`;
await fs.writeFile(path.join(agent,"settings.json"),JSON.stringify({defaultProvider:"openai-codex",defaultModel:"test",defaultTools:["read","write","process_run"],retry:{enabled:false},compaction:{enabled:false}}));
await fs.writeFile(path.join(agent,"models.json"),JSON.stringify({providers:{"openai-codex":{api:"openai-codex-responses",baseUrl:"https://chatgpt.com/backend-api",models:[{id:"test",name:"Fixture",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
const token = "synthetic."+Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"synthetic-account"}})).toString("base64")+".synthetic";
await fs.writeFile(path.join(agent,"auth.json"),JSON.stringify({"openai-codex":{type:"oauth",access:token,refresh:"DISABLED_SYNTHETIC",expires:Date.now()+3600000,accountId:"synthetic-account"}}));
const preload=path.join(base,"smoke-preload.cjs");
await fs.writeFile(preload,`const original=globalThis.fetch;globalThis.fetch=(input,options)=>{const url=typeof input==="string"?input:input.url??String(input);if(url!=="https://chatgpt.com/backend-api/codex/responses")throw Error("Unexpected network: "+url);return original(${JSON.stringify(url)},options);};`);
await fs.mkdir(path.join(agent,"configs"),{recursive:true});
for(const file of ["auto-title","discord-presence"])await fs.writeFile(path.join(agent,"configs",file+".jsonc"),'{"enabled":false}');
try{
 const result=await promisify(execFile)(path.join(app,"pimoon.exe"),["--require",preload,path.join(app,"resources/app/backend.mjs"),"--provider","openai-codex","--model","test","--thinking","off","--system-prompt","Isolated packaged smoke test. Execute the requested Python once.","--mode","json","-p","--no-session","--tools","read,write,process_run","Run packaged fixture."],{cwd,env,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
 await fs.writeFile(path.join(base,"smoke-output.txt"),result.stdout+"\n"+result.stderr);
 const events=result.stdout.split("\n").filter(line=>line.startsWith("{")).map(line=>JSON.parse(line));
 const rootResult=events.find(event=>event.type==="tool_execution_end"&&event.toolName==="execute");
 const scheduling=rootResult?.result?.details?.scheduling;
 if(scheduling?.version!==1||scheduling.state!=="completed"||scheduling.groups.length!==2
  ||scheduling.groups[0].peak!==2||scheduling.groups[0].operations.some(item=>item.state!=="ok")
  ||scheduling.groups[1].operations.some(item=>item.state!=="error")
  ||!events.some(event=>event.type==="tool_execution_update"&&event.toolName==="execute"&&event.partialResult?.details?.scheduling))throw Error("Packaged scheduling UI metadata mismatch");
 const content=await fs.readFile(path.join(cwd,"packaged.txt"),"utf8");
 const proof=JSON.parse(await fs.readFile(path.join(cwd,"proof.json"),"utf8"));
 if(JSON.stringify(proof)!=='{"returncode":0,"failed_returncode":7,"reads":5,"missing_codes":["FILE_NOT_FOUND","FILE_NOT_FOUND"]}')throw Error("Packaged subprocess result mismatch");
 const telemetry=[];
 for(const directory of await fs.readdir(path.join(env.PIMOON_HOME,"telemetry")))for(const file of await fs.readdir(path.join(env.PIMOON_HOME,"telemetry",directory))){
  if(file.endsWith(".jsonl"))telemetry.push(...(await fs.readFile(path.join(env.PIMOON_HOME,"telemetry",directory,file),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));
 }
 const execution=telemetry.find(row=>row.type==="code_end");
 if(execution?.metrics?.batch_peak_concurrency!==2||execution?.metrics?.batch_calls!==2)throw Error("Packaged explicit groups or sequential boundary mismatch");
 if(content!=="once"||requests!==2||!result.stdout.includes("packaged complete")||declarations.some(names=>JSON.stringify(names)!=='["execute"]'))throw Error("packaged verification failed");
 console.log(JSON.stringify({ok:true,requests,declarations,content,windowStarted:false}));
 await fs.writeFile(path.join(base,"smoke-result.json"),JSON.stringify({ok:true,requests,declarations,content,windowStarted:false},null,2));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
