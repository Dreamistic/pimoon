import type { ExecutionScheduling } from "../../../src/pimoon/scheduling.ts";
export const schedulingFixture: ExecutionScheduling = {version:1,state:"completed",truncated:false,groups:[{
 id:1,policy:"raise",total:3,state:"completed",elapsedMs:100,peak:3,overlapMs:140,
 operations:[
  {index:0,name:"read",target:"src/main.ts",state:"ok",startMs:0,durationMs:100},
  {index:1,name:"native_read",target:"settings.json",state:"ok",startMs:5,durationMs:75},
  {index:2,name:"grep",target:"src · TODO",state:"ok",startMs:10,durationMs:65},
 ]
}]};
