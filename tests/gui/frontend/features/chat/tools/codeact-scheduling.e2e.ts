import {test,expect} from "@playwright/test";
import type {GuiSnapshot} from "../../../../../../src/gui/shared/protocol/state.ts";
import type {ExecutionScheduling} from "../../../../../../src/pimoon/scheduling.ts";
import {replayTranscript} from "../../../../helpers/transcript-live-fixture.ts";
import {guiSnapshot,guiModelFixture} from "../../../../helpers/snapshot-fixture.ts";
import {assistant} from "../../../../helpers/transcript-fixtures.ts";
import {schedulingFixture} from "../../../../helpers/scheduling-fixture.ts";

// 定向浏览器验证补足 SSR 无法覆盖的布局、折叠记忆和实时状态更新。
test("并发标记融入标题且不覆盖折叠，减少动效、深浅色和大字号可用",async({page},info)=>{
 const group=schedulingFixture.groups[0];if(!group)throw Error("fixture missing");
 const {overlapMs: _overlap, ...unfinished}=group;
 const running:ExecutionScheduling={...schedulingFixture,state:"running",groups:[{...unfinished,state:"running",operations:group.operations.map(({durationMs: _duration,...op})=>({...op,state:"running"}))}]};
 const args={code:'items=parallel([(read,{"path":"src/main.ts"}),(read,{"path":"settings.json","mode":"raw"})])',desc:"读取并核对配置"};
 const message=assistant([{type:"toolCall",id:"parallel-execution",name:"execute",arguments:args}],"toolUse");
 const model=guiModelFixture();
 const snapshot:GuiSnapshot={...guiSnapshot(),model,models:[model],running:true,streaming:true,
  contextEntryIds:["user","execution"],entries:[
   {id:"user",parentId:null,type:"message",timestamp:new Date(1).toISOString(),label:undefined,messages:[{role:"user",content:"检查配置",timestamp:1}]},
   {id:"execution",parentId:"user",type:"message",timestamp:new Date(2).toISOString(),label:undefined,messages:[message]},
  ],liveTools:[{toolCallId:"parallel-execution",toolName:"execute",args,output:{kind:"inline",value:{content:[],details:{scheduling:running}}}}]};
 const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
 const channel=await replayTranscript(page,snapshot);
 try{
  const card=page.locator('[data-tool-call-id="parallel-execution"]');
  await expect(card.locator(".scheduling-badge")).toContainText("峰值 3");
  await expect(card.locator(".activity-summary .scheduling-badge")).toBeVisible();
  await expect(card.locator(".scheduling-panel")).toHaveCount(0);
  const summary=card.locator('> [data-slot="collapsible"] > .activity-summary');
  await summary.click();await expect(summary).toHaveAttribute("aria-expanded","false");
  channel.accept({type:"snapshot",value:{...snapshot,liveTools:[{toolCallId:"parallel-execution",toolName:"execute",args,output:{kind:"inline",value:{content:[],details:{scheduling:schedulingFixture}}},completion:{isError:false,durationMs:120}}]}});
  await expect(summary).toContainText("执行完成");
  await expect(summary).toHaveAttribute("aria-expanded","false");
  await expect(summary.locator(".scheduling-badge")).toContainText("并发 · 峰值 3");
  await summary.click();await expect(summary).toHaveAttribute("aria-expanded","true");
  await page.emulateMedia({reducedMotion:"reduce"});
  const toggle=summary;
  for(const theme of ["light","dark"]as const){
   await page.emulateMedia({colorScheme:theme});
   await page.evaluate(()=>{document.documentElement.style.fontSize="100%";});
   await toggle.scrollIntoViewIfNeeded();
   await page.screenshot({path:info.outputPath(`parallel-normal-${theme}.png`)});
   await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
   await toggle.scrollIntoViewIfNeeded();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
   await expect(toggle).toBeInViewport();
   await page.screenshot({path:info.outputPath(`parallel-${theme}.png`)});
  }
  expect(errors).toEqual([]);
 }finally{channel.close();}
});
