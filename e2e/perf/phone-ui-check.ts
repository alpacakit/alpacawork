/** Inspect real clipping, focus, task turns, motion and native body input on fixed releases; no timing claim. */
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Locator } from '@playwright/test';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}
const {values:args}=parseArgs({options:{before:{type:'string'},after:{type:'string'},out:{type:'string'},side:{type:'string'}}});
if(!args.before||!args.after||!args.out)throw Error('--before --after --out required');
const out=resolve(args.out);mkdirSync(out,{recursive:true});
const original=createOriginal({...profiles.perf,seed:'synthetic-v1'});
const children:ReturnType<typeof spawn>[]=[];let browser:Browser|undefined;
const expiry=setTimeout(()=>{for(const child of children)child.kill('SIGTERM');void browser?.close();process.exitCode=3;},15*60_000);
const terminate=()=>{for(const child of children)child.kill('SIGTERM');void browser?.close();process.exitCode=3;};
process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
const results:any[]=[];
const save=()=>writeFileSync(join(out,'checks.json'),JSON.stringify({before:args.before,after:args.after,fixture:original.key,width:390,height:900,throttle:4,browser:browser?.version(),results},null,2));
try{
 browser=await chromium.launch();
 for(const [label,release]of [['before',args.before],['after',args.after]]as const){
  if(args.side&&args.side!==label)continue;
  const dir=join(out,label);mkdirSync(dir,{recursive:true});const root=join(dir,'workspace');copyWorkspace(original.root,root);
  const child=spawn(process.execPath,[join(resolve(release),'apps/backend/dist/backend.js'),'--workspace',root,'workspace','serve','--port','0'],{env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('ALPACAWORK_'))),stdio:['ignore','pipe','pipe']});children.push(child);let log='';child.stdout!.on('data',b=>{log+=b;});child.stderr!.on('data',b=>{log+=b;});
  const checks:any[]=[];let context:Awaited<ReturnType<Browser['newContext']>>|undefined;
  const check=(name:string,pass:boolean,data:unknown)=>{checks.push({name,pass,data});save();if(!pass)throw Error(name+': '+JSON.stringify(data));};
  try{
   const deadline=Date.now()+60000;let url='';while(!(url=/http:\/\/[\w.:]+/.exec(log)?.[0]??'')){if(Date.now()>deadline||child.exitCode!==null)throw Error(log);await new Promise(r=>setTimeout(r,100));}
   await new Promise(r=>setTimeout(r,6000));
   context=await browser.newContext({viewport:{width:390,height:900},hasTouch:true,isMobile:true,locale:'en-US',serviceWorkers:'block',recordVideo:{dir:join(dir,'video'),size:{width:390,height:900}}});
   const page=await context.newPage();page.setDefaultTimeout(20000);
   // Static screenshots and both releases see the same local day and clock.
   await page.clock.setSystemTime(new Date('2026-11-02T15:00:00Z'));
   await page.addInitScript(()=>{
    const w=window as any;w.uiProbe={observed:0,inputs:[],motions:[]};
    const Original=window.ResizeObserver;window.ResizeObserver=class extends Original{observe(target:Element,options?:ResizeObserverOptions){if(target.matches('[data-reader-path]'))w.uiProbe.observed++;super.observe(target,options);}};
    document.addEventListener('pointerdown',e=>{const at=e.target as Element;w.uiProbe.inputs.push({type:e.type,x:e.clientX,y:e.clientY,content:!!at.closest('[data-reader-content]'),grip:!!at.closest('[data-task-sheet-grab]')});},true);
    const animate=Element.prototype.animate;Element.prototype.animate=function(...args:Parameters<typeof animate>){w.uiProbe.motions.push({frames:args[0],timing:args[1]});return animate.apply(this,args);};
   });
   const conversation={id:'interaction-latency',nextLaunch: { agent: 'claude', values: {} },busy: false, earlier: null, resets: [], context: null, autoReset: { tokens: 200_000, percent: 50 },turns:Array.from({length:40},(_,i)=>({id:`turn-${i}`,at:new Date(Date.UTC(2026,10,2,15,i)).toISOString(),ask:`Measured request ${i} about T2 and T3`,attachments:[],status:'succeeded',waiting:false,seen:true,error:null,result:null,answer:Array.from({length:i===39?40:2},(_,n)=>`### Result ${n}\nT2 continues after T3. **Check** the report and its result.\n\n- First point\n- Second point\n`).join(''),answeredAt:new Date(Date.UTC(2026,10,2,15,i,30)).toISOString()}))};
   await page.route('**/api/coordinator',async route=>{const reply=await route.fetch();await route.fulfill({response:reply,json:{...await reply.json(),conversation}});});
   const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Tokyo'});await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
   const settle=async()=>{await page.waitForTimeout(200);await page.waitForFunction(()=>!document.getAnimations().some(a=>a.effect?.getComputedTiming().iterations!==Infinity&&(a.pending||a.playState==='running')));await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));};
   const tap=async(target:Locator)=>{const b=await target.boundingBox();if(!b)throw Error('Missing native target');const point={x:b.x+b.width/2,y:b.y+b.height/2};if(point.y<0||point.y>=900)throw Error('Off-screen target');await page.touchscreen.tap(point.x,point.y);};
   const live=page.locator('[data-sheet] aside[data-reader-mode=sheet]');
   const clip=async(name:string)=>{
    const data=await page.locator('[data-reader-path]').evaluate(nav=>{const bottom=nav.getBoundingClientRect().bottom;return [...nav.children].map(el=>({text:el.textContent,top:el.getBoundingClientRect().top,bottom,inert:(el as HTMLElement).inert,expected:el.getBoundingClientRect().top>=bottom}));});check(name,data.every(v=>v.inert===v.expected),data);
   };
   await page.goto(url+'/?agent=1&task=T2');await page.locator('[data-history-ready=true]').waitFor();await settle();
   const observed=await page.evaluate(()=>(window as any).uiProbe.observed);
   for(let i=0;i<3;i++){
    for(const selector of ['[data-list-next]','[data-list-previous]']){await page.evaluate(()=>{(window as any).uiProbe.motions=[];});await tap(live.locator(selector));await settle();await clip('task-turn '+i+selector);checks.push({name:'turn-motion '+i+selector,pass:true,data:await page.evaluate(()=>(window as any).uiProbe.motions)});}
   }
   const afterObserved=await page.evaluate(()=>(window as any).uiProbe.observed);
   checks.push({name:'observer lifetime (diagnostic; unchanged owner)',pass:true,data:{observed,afterObserved,retained:afterObserved===observed}});
   await page.goto(url+'/?agent=1&task=T9001');await page.locator('[data-history-ready=true]').waitFor();await settle();
   for(const width of [360,390,900,1440])for(const px of [16,24,32]){
    await page.setViewportSize({width,height:900});await page.evaluate(px=>document.documentElement.style.fontSize=px+'px',px);await settle();await clip(`clip ${width}px text${px}`);await page.screenshot({path:join(dir,`path-${width}-${px}.png`)});
   }
   await page.setViewportSize({width:390,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='16px');await page.goto(url+'/?agent=1&task=T9001');await page.locator('[data-history-ready=true]').waitFor();await settle();await clip('path geometry (check child count for ancestor coverage)');
   await live.locator('[data-reader-frame-buttons] button').last().focus();const tabbed:any[]=[];
   for(let i=0;i<18;i++){await page.keyboard.press('Tab');const focus=await page.evaluate(()=>{const el=document.activeElement as HTMLElement;const nav=el?.closest('[data-reader-path]');if(!nav)return null;let step=el;while(step.parentElement!==nav)step=step.parentElement!;return{text:el.textContent,inert:step.inert,top:step.getBoundingClientRect().top,bottom:nav.getBoundingClientRect().bottom};});if(focus){tabbed.push(focus);check('Tab skips clipped path',!focus.inert&&focus.top<focus.bottom,focus);}}
   checks.push({name:'Tab traversal (empty observations mean not covered)',pass:true,data:tabbed});
   await page.emulateMedia({reducedMotion:'reduce'});await page.goto(url+'/?agent=1&task=T2');await page.locator('[data-history-ready=true]').waitFor();await settle();await page.evaluate(()=>{(window as any).uiProbe.motions=[];});await tap(live.locator('[data-list-next]'));await settle();await clip('reduced-motion task turn');checks.push({name:'reduced-motion keyframes',pass:true,data:await page.evaluate(()=>(window as any).uiProbe.motions)});await page.emulateMedia({reducedMotion:'no-preference'});
   await page.goto(url+'/?agent=1');await page.locator('[data-read]').first().waitFor();await settle();await tap(page.locator('[data-read]').first());await page.locator('[data-history-ready=true]').waitFor();await settle();await page.screenshot({path:join(dir,'detail.png')});
   const area=live.locator('[data-reader-content]');const box=await area.boundingBox();if(!box)throw Error('No body');
   const y=await live.evaluate(el=>{const c=el.querySelector('[data-reader-content]')!,h=el.querySelector('[data-reader-header]')!,t=el.querySelector('[data-head-title]');return Math.max(c.getBoundingClientRect().top,h.getBoundingClientRect().bottom,t?.getBoundingClientRect().bottom??0)+16;});const x=box.x+box.width-8;
   const hit=await page.evaluate(({x,y})=>{const el=document.elementFromPoint(x,y);return{content:!!el?.closest('[data-reader-content]'),grip:!!el?.closest('[data-task-sheet-grab]')};},{x,y});check('body elementFromPoint',hit.content&&!hit.grip,hit);await page.evaluate(()=>{(window as any).uiProbe.inputs=[];});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+Math.min(500,900-y-8)*i/8}]});await page.waitForTimeout(30);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await live.waitFor({state:'detached'});await settle();
   const input=await page.evaluate(()=>(window as any).uiProbe.inputs[0]);check('body native target',input?.content&&!input?.grip,input);
   await tap(page.locator('[data-coordinator-expand]').first());await settle();await page.locator('[data-earlier] button').scrollIntoViewIfNeeded();await tap(page.locator('[data-earlier] button'));await settle();check('history expanded',await page.locator('[data-coordinator-message]').count()===40,await page.locator('[data-coordinator-message]').count());await page.screenshot({path:join(dir,'history.png')});check('history entrance removed',await page.locator('[data-earlier]').count()===0,await page.locator('[data-earlier]').count());await foldChat(page, tap);await settle();
   const times=async(name:string)=>{
    const data=await page.locator('[data-coordinator-message] time[datetime]').evaluateAll(elements=>elements.map(el=>{
     const at=el.getAttribute('datetime')!,date=new Date(at);
     const expected=date.toLocaleString('en',{...(date.toDateString()!==new Date().toDateString()?{month:'numeric',day:'numeric'}:{}),hour:'2-digit',minute:'2-digit',hour12:false});
     return{at,text:el.textContent,expected,today:date.toDateString()===new Date().toDateString()};
    }));check(name,data.length>=2&&data.every(row=>row.text===row.expected),data);
   };
   await page.clock.setSystemTime(new Date('2026-11-03T14:58:00Z'));await page.goto(url+'/?agent=1');await page.locator('[data-read]').first().waitFor();await settle();
   await tap(page.locator('[data-coordinator-expand]').first());await settle();await times('time before day boundary');
   check('today before midnight',await page.evaluate(()=>new Date().getDate()===3),await page.evaluate(()=>new Date().toString()));
   await page.clock.setSystemTime(new Date('2026-11-03T15:00:01Z'));
   await tap(page.locator('[data-search-toggle]'));await settle();
   if(!await page.locator('[data-coordinator-message] time[datetime]').count()){await tap(page.locator('[data-coordinator-expand]').first());await settle();}
   await times('time after next local day and reopening from search');
   await cdp.send('Emulation.setTimezoneOverride',{timezoneId:''});
   await cdp.send('Emulation.setTimezoneOverride',{timezoneId:'America/New_York'});
   await page.locator('[data-search-row] input').focus();await page.keyboard.insertText('Synthetic');
   await page.waitForFunction(()=>new URL(location.href).searchParams.get('q')==='Synthetic');await settle();
   if(!await page.locator('[data-coordinator-message] time[datetime]').count()){await tap(page.locator('[data-coordinator-expand]').first());await settle();}
   await times('time after changed runtime zone and reopening from search');
   await page.screenshot({path:join(dir,'time-zone.png')});
   writeFileSync(join(dir,'process-tree.txt'),execFileSync('/bin/ps',['-eo','pid,ppid,pcpu,stat,args'],{encoding:'utf8'}));
  }catch(error){cpSync(root,join(dir,'failure-workspace'),{recursive:true});if(context){const p=context.pages()[0];if(p){await p.screenshot({path:join(dir,'failure.png')}).catch(()=>{});writeFileSync(join(dir,'failure-dom.txt'),await p.locator('body').innerText().catch(()=>''));}}throw error;}
  finally{await context?.close();if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}writeFileSync(join(dir,'server.log'),log);removeWorkspace(root);results.push({label,serverPid:child.pid,checks,stopped:true,exit:child.exitCode,signal:child.signalCode});save();}
 }
}finally{clearTimeout(expiry);process.off('SIGTERM',terminate);process.off('SIGINT',terminate);await browser?.close();writeFileSync(join(out,'stopped.json'),JSON.stringify({runner:process.pid,servers:children.map(c=>({pid:c.pid,exit:c.exitCode,signal:c.signalCode})),browserConnected:browser?.isConnected()}));save();}
