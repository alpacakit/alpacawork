/** Actual targets under a 500ms main-thread block. This is visual evidence, never a timing run. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { seedTimelineScroll } from '../fixture/timeline-scroll.ts';
import { setStrips } from './bar-entries.ts';
const output=resolve(process.argv[2]!);mkdirSync(output,{recursive:true});
const browser=await chromium.launch();let runtime: Awaited<ReturnType<typeof start>> | undefined;
const expiry=setTimeout(()=>process.exit(3),12*60_000);const results:any[]=[];
try{runtime=await start(undefined,seedTimelineScroll,resolve('.local/pull-loading-runtime',basename(output)+'-'+Date.now()));
for(const rate of [1,4])for(const phase of ['release','loading','return']){
 const context=await browser.newContext({viewport:{width:390,height:900},hasTouch:true,isMobile:true,serviceWorkers:'block',locale:'en-US',timezoneId:'Asia/Tokyo'});
 let open=()=>{};
 try{
  const page=await context.newPage();await page.goto(runtime.origin+'/?agent=1&zoom=1800000');await page.locator('[data-pull-mark]').waitFor();
  await setStrips(page,true);
  await page.locator('[data-span]').waitFor();await page.waitForTimeout(800);
  const gate=new Promise<void>(done=>{open=done});await page.route('**/api/events',async route=>{await gate;await route.continue();});
  const c=await context.newCDPSession(page);await c.send('Emulation.setCPUThrottlingRate',{rate});await c.send('Page.enable');
  await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:300}]});const t=Date.now()/1000;
  for(let i=1;i<=20;i++){await c.send('Input.dispatchTouchEvent',{type:'touchMove',timestamp:t+i*.016,touchPoints:[{x:195,y:300+i*15}]});await page.waitForTimeout(16);}
  assert.equal(await page.locator('[data-pull-mark]').getAttribute('data-phase'),'armed');
  const shots:any[]=[];const start=Date.now()/1000;
  const receive=(s:any)=>{shots.push({at:s.metadata.timestamp,data:s.data});void c.send('Page.screencastFrameAck',{sessionId:s.sessionId}).catch(()=>{});};
  c.on('Page.screencastFrame',receive);
  const capture=()=>c.send('Page.startScreencast',{format:'png',everyNthFrame:1});
  if(phase==='release')await capture();
  await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  if(phase==='release')await page.waitForTimeout(50);
  else{await page.waitForTimeout(700);if(phase==='return'){open();await page.waitForFunction(()=>document.querySelector('[data-pull-mark]')?.getAttribute('data-phase')==='done');}
   await capture();await page.waitForTimeout(phase==='return'?360:100);}
  const before=await page.evaluate(()=>{const mark=document.querySelector('[data-pull-mark]')!,sheet=document.querySelector('[data-time-tree]')!.children[1] as HTMLElement;
   return{phase:mark.getAttribute('data-phase'),mark:mark.getBoundingClientRect().toJSON(),ring:mark.querySelector('span')!.getBoundingClientRect().toJSON(),sheet:sheet.getBoundingClientRect().toJSON(),transform:sheet.style.transform,spin:mark.querySelector('[style*=rotate]')!.getBoundingClientRect().toJSON()};});
  const dispatchedAt=Date.now()/1000;
  const blocked=await page.evaluate(()=>{const start=Date.now()/1000;const until=performance.now()+500;while(performance.now()<until){}return{start,end:Date.now()/1000};});
  const blockedAt=blocked.start,unblockedAt=blocked.end;await page.waitForTimeout(200);await c.send('Page.stopScreencast');c.off('Page.screencastFrame',receive);
  const dir=output+'/'+rate+'-'+phase;mkdirSync(dir,{recursive:true});
  const frames=shots.map((s,i)=>{const file=String(i).padStart(3,'0')+'.png';writeFileSync(dir+'/'+file,Buffer.from(s.data,'base64'));return{file,ms:Math.round((s.at-start)*1000),duringBlock:s.at>=blockedAt&&s.at<unblockedAt};});
  results.push({rate,phase,before,dispatchMs:Math.round((dispatchedAt-start)*1000),blockMs:[Math.round((blockedAt-start)*1000),Math.round((unblockedAt-start)*1000)],frames});
  writeFileSync(output+'/results.json',JSON.stringify({browser:browser.version(),results},null,2));console.log(rate,phase,'block frames',frames.filter(f=>f.duringBlock).length);
  open();await c.detach();
 }finally{open();await context.close();}
}}finally{clearTimeout(expiry);try{await browser.close();}finally{await runtime?.stop();}}
