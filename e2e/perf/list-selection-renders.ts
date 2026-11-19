/** List commits when selection changes; reader motion is measured by reader-motion.ts. */
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { writeFileSync } from 'node:fs';
const out=process.argv[2]!;const runtime=await start(undefined, root => { for (const id of ['T112', 'T114']) patchTask(root,id,{userRequested:true}); });const browser=await chromium.launch();const results:any[]=[];const expiry=setTimeout(()=>process.exit(3),120_000);
try{for(const width of [1440,390]){
const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<700});
await page.addInitScript(()=>{
const p=(window as any).listSelection={active:false,root:0,list:0};
Object.defineProperty(window,'__REACT_DEVTOOLS_GLOBAL_HOOK__',{value:{renderers:new Map(),supportsFiber:true,isDisabled:false,checkDCE(){},inject(){return 1},onCommitFiberRoot(_:any,root:any){if(!p.active)return;p.root++;const walk=(f:any)=>{if(f.tag===5&&f.memoizedProps?.['data-time-tree']!==undefined){let parent=f.return;while(parent&&typeof parent.type!=='function')parent=parent.return;if(parent?.flags&1)p.list++;}if(f.alternate&&f.alternate.child===f.child)return;for(let child=f.child;child;child=child.sibling)walk(child)};walk(root.current)},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},onScheduleFiberRoot(){}}});
});
await page.goto(runtime.origin+'/?agent=1&task=T112');await page.locator('[data-time-tree]').waitFor();await page.waitForTimeout(1200);
for(const task of ['T113','T114','T112']){
 const button=page.locator(`[data-row="${task}"] [data-row-label] [data-read="${task}"]`);
 await button.waitFor();await page.evaluate(()=>Object.assign((window as any).listSelection,{active:true,root:0,list:0}));
 // On 390 the reader can cover the list. Dispatch its existing handler only, never claim a visible-pointer operation.
 await button.evaluate((el:HTMLElement)=>el.click());await page.waitForTimeout(700);
 const counts=await page.evaluate(()=>{const p=(window as any).listSelection;p.active=false;return{root:p.root,list:p.list}});results.push({width,task,kind:'existing-row-handler',...counts});
}
await page.close();
}}finally{clearTimeout(expiry);await browser.close();await runtime.stop();writeFileSync(out,JSON.stringify(results,null,2))}
console.log(results);
