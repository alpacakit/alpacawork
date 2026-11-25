/** Actual pull phases. Filming is a separate pass. All fixtures are inert, isolated, and kept outside Task data. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { loadavg } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { seedTimelineScroll } from '../fixture/timeline-scroll.ts';
import { commandFetch as fetch } from '../../tests/helpers/command-fetch.ts';
import { installProbe } from './list-motion-probe.ts';
import { setStrips } from './bar-entries.ts';
const {values:args,positionals}=parseArgs({allowPositionals:true,options:{throttle:{type:'string',default:'1'},rounds:{type:'string',default:'3'},film:{type:'boolean',default:false},reduced:{type:'boolean',default:false},diagnostic:{type:'boolean',default:false},withoutSelect:{type:'boolean',default:false}}});
const output=resolve(positionals[0]!);mkdirSync(dirname(output),{recursive:true});
const throttle=Number(args.throttle),results:any[]=[],flows:any[]=[];
assert([1,4].includes(throttle));assert(Number.isInteger(Number(args.rounds)) && Number(args.rounds)>0);
const browser=await chromium.launch();const expiry=setTimeout(()=>process.exit(3),15*60_000);
let runtime: Awaited<ReturnType<typeof start>> | undefined;
let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
try {
runtime=await start(undefined,seedTimelineScroll,resolve('.local/pull-loading-runtime',basename(output)+'-'+Date.now()));
context=await browser.newContext({viewport:{width:390,height:900},hasTouch:true,isMobile:true,locale:'en-US',timezoneId:'Asia/Tokyo',serviceWorkers:'block',reducedMotion:args.reduced?'reduce':'no-preference'});
const save=()=>writeFileSync(output,JSON.stringify({version:1,browser:browser.version(),width:390,height:900,throttle,reduced:args.reduced,filming:args.film,withoutSelect:args.withoutSelect,results,flows},null,2));
const liveRuntime=runtime;
 const page=await context.newPage();await installProbe(page);
 if(args.diagnostic)await page.addInitScript(()=>{
  (window as any).pullIO=[];const Native=window.IntersectionObserver;
  window.IntersectionObserver=class extends Native {constructor(callback:IntersectionObserverCallback,options?:IntersectionObserverInit){super((entries,observer)=>{if((options?.root as Element)?.matches?.('[data-time-tree]'))(window as any).pullIO.push({at:performance.now(),rows:entries.filter(e=>(e.target as HTMLElement).dataset.row).map(e=>({id:(e.target as HTMLElement).dataset.row,intersect:e.isIntersecting,top:e.boundingClientRect.top,bottom:e.boundingClientRect.bottom,root:e.rootBounds?.toJSON()}))});callback(entries,observer);},options);}};
 });
 const requests:any[]=[];let segment='setup';page.on('request',r=>{if(args.diagnostic)requests.push({at:Date.now(),segment,url:new URL(r.url()).pathname});});
 await page.goto(runtime.origin+'/?agent=1&zoom=1800000');await page.locator('[data-time-tree]').waitFor();
 await setStrips(page,true);
 await page.locator('[data-span]').waitFor();await page.waitForTimeout(1400);
 if(args.withoutSelect)await page.locator('[data-span]').evaluate(el=>el.remove());
 const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Page.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:throttle});
 await page.evaluate(()=>{
  const p: {events: {at:number;phase:string|null}[];styles:{at:number;target:string;old:string;now:string}[];phaseWrites:number}=(window as any).pullProbe={events:[],styles:[],phaseWrites:0};
  const mark=document.querySelector('[data-pull-mark]')!,sheet=document.querySelector('[data-time-tree]')!.children[1]!;
  let phase=mark.getAttribute('data-phase');
  const changed=new MutationObserver(records=>{
   for(const r of records){const el=r.target as Element;
    if(r.attributeName==='data-phase'){p.phaseWrites++;const next=el.getAttribute('data-phase');if(next!==phase){phase=next;p.events.push({at:performance.now(),phase});}}
    if(r.attributeName==='style'){
     const old=r.oldValue??'',now=el.getAttribute('style')??'';
     if(old!==now)p.styles.push({at:performance.now(),target:el.getAttributeNames().filter(k=>k.startsWith('data-')).join(',')||el.tagName,old,now});
    }
   }
  });changed.observe(mark,{attributes:true,subtree:true,attributeOldValue:true,attributeFilter:['style','data-phase']});changed.observe(sheet,{attributes:true,attributeOldValue:true,attributeFilter:['style']});
 });
 const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 let flowStart=0;
 const measure=async(name:string,work:()=>Promise<void>)=>{
  const hostBefore={at:new Date().toISOString(),load:loadavg()};const a=await metrics();
  await page.evaluate(()=>{Object.assign(window.listMotion,{frames:[],last:0,loaf:[],commits:0,css:[],animations:[]});Object.assign((window as any).pullProbe,{events:[],styles:[],phaseWrites:0});if((window as any).pullIO)(window as any).pullIO=[]});
  const begin=Date.now();segment=name;await work();const b=await metrics();const end=Date.now();
  const p=await page.evaluate(()=>({motion:window.listMotion,pull:(window as any).pullProbe,io:(window as any).pullIO,phase:document.querySelector('[data-pull-mark]')!.getAttribute('data-phase')}));
  // A single animation/style snapshot after the metrics interval; never read geometry once per frame.
  const glyph=await page.locator('[data-pull-mark]').evaluate(el=>{const turn=el.querySelector('[style*=rotate]')!,arc=el.querySelector('circle')!;return{rotate:getComputedStyle(turn).rotate,dashoffset:getComputedStyle(arc).strokeDashoffset,opacity:getComputedStyle(el).opacity,phase:el.getAttribute('data-phase'),selectCount:document.querySelectorAll('[data-span]').length};});
  assert.equal(glyph.selectCount,args.withoutSelect?0:1);
  const animations=await page.locator('[data-pull-mark]').evaluate(el=>el.getAnimations({subtree:true}).map(a=>({name:a instanceof CSSAnimation?a.animationName:a instanceof CSSTransition?a.transitionProperty:a.id,props:a.effect instanceof KeyframeEffect?[...new Set(a.effect.getKeyframes().flatMap(k=>Object.keys(k).filter(p=>!['offset','computedOffset','easing','composite'].includes(p))))]:[]})));
  segment='between';
  const delta=(key:string)=>b[key]!-a[key]!;const frame=p.motion.frames;
  const row={name,width:390,throttle,valid:true,startMs:begin-flowStart,durationMs:end-begin,host:{before:hostBefore,after:{at:new Date().toISOString(),load:loadavg()}},phaseAfter:p.phase,
   frames:{count:frame.length,missed:frame.reduce((n,g)=>n+Math.max(0,Math.round(g/16.67)-1),0),late:frame.filter(g=>g>25).length,max:Math.max(0,...frame)},loaf:p.motion.loaf,commits:p.motion.commits,
   cdp:{layouts:delta('LayoutCount'),layoutMs:delta('LayoutDuration')*1000,styles:delta('RecalcStyleCount'),styleMs:delta('RecalcStyleDuration')*1000,scriptMs:delta('ScriptDuration')*1000,taskMs:delta('TaskDuration')*1000},
   waapi:p.motion.animations,css:p.motion.css,activeAnimations:animations,glyph,pull:p.pull,io:p.io,requests:requests.filter(r=>r.segment===name)};results.push(row);save();console.log(name,JSON.stringify({cdp:row.cdp,missed:row.frames.missed,commits:row.commits,phaseWrites:p.pull.phaseWrites}));return row;
 };
 let gateClosed=false,openGate=()=>{};let gate=Promise.resolve();
 await page.route('**/api/events',async route=>{if(gateClosed)await gate;await route.continue();});
 for(let round=0;round<Number(args.rounds);round++){
  await page.locator('[data-time-tree]').evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(500);
  assert.equal(await page.locator('[data-pull-mark]').getAttribute('data-phase'),'rest');
  gate=new Promise<void>(done=>{openGate=done});gateClosed=true;
  const shots:any[]=[];let filmStart=0;
  const shot=(e:any)=>{shots.push({at:e.metadata.timestamp,data:e.data});void cdp.send('Page.screencastFrameAck',{sessionId:e.sessionId}).catch(()=>{});};
  if(args.film){cdp.on('Page.screencastFrame',shot);filmStart=Date.now()/1000;await cdp.send('Page.startScreencast',{format:'jpeg',quality:85,everyNthFrame:1});await page.waitForTimeout(150);}
  flowStart=Date.now();const points:any[]=[];
  try{
   await measure('drag-'+round,async()=>{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:300}]});
    const base=Date.now()/1000;
    for(let i=1;i<=20;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',timestamp:base+i*.016,touchPoints:[{x:195,y:300+i*15}]});points.push({at:Date.now()-flowStart,x:195,y:300+i*15});await page.waitForTimeout(16);}
    assert.equal(await page.locator('[data-pull-mark]').getAttribute('data-phase'),'armed');
   });
   await measure('release-'+round,async()=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(600);assert.equal(await page.locator('[data-pull-mark]').getAttribute('data-phase'),'refreshing');});
   await measure('loading-'+round,async()=>{
    const view=await(await fetch(liveRuntime.origin+'/api/task/view?task=T2063')).json();
    const r=await fetch(liveRuntime.origin+'/api/commands/task/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({task:'T2063',title:'Loading update '+round,expectedTaskHash:view.task.hash})});assert.equal(r.status,200,await r.clone().text());
    await page.waitForTimeout(400);gateClosed=false;openGate();
    await page.locator('[data-row=T2063] [data-row-label]').filter({hasText:'Loading update '+round}).waitFor();
    await page.waitForFunction(()=>document.querySelector('[data-pull-mark]')!.getAttribute('data-phase')==='done');
   });
   await measure('return-'+round,async()=>{await page.waitForFunction(()=>document.querySelector('[data-pull-mark]')!.getAttribute('data-phase')==='rest');});
   const geometry=await page.evaluate(()=>{const mark=document.querySelector('[data-pull-mark]') as HTMLElement;const sheet=document.querySelector('[data-time-tree]')!.children[1] as HTMLElement;return{phase:mark.dataset.phase,transform:sheet.style.transform,willChange:sheet.style.willChange,opacity:getComputedStyle(mark).opacity};});
   assert.equal(geometry.transform,'');assert.equal(geometry.willChange,'');assert.equal(geometry.opacity,'0');
   flows.push({round,points,geometry,filmOffsetMs:args.film?flowStart-filmStart*1000:0});save();
  }finally{
   gateClosed=false;openGate();
   if(args.film){await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',shot);const dir=output+'.film/390-pull-'+round;mkdirSync(dir,{recursive:true});for(const s of shots)writeFileSync(dir+'/'+String(Math.max(0,Math.round((s.at-filmStart)*1000))).padStart(5,'0')+'.jpg',Buffer.from(s.data,'base64'));}
  }
 }
 await page.screenshot({path:output+'.png'});
 await cdp.detach();
}finally{clearTimeout(expiry);try{await context?.close();}finally{try{await browser.close();}finally{await runtime?.stop();}} }
