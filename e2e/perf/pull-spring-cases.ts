/** Preserved gesture/lifecycle behavior, observed through the real product in Chromium. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {start} from '../server.ts';
import {seedTimelineScroll} from '../fixture/timeline-scroll.ts';
const out=resolve(process.argv[2]!);mkdirSync(out,{recursive:true});
const browser=await chromium.launch();let runtime:Awaited<ReturnType<typeof start>>|undefined;
const results:any[]=[];
try{runtime=await start(undefined,seedTimelineScroll,resolve('.local/pull-loading-runtime/cases-'+Date.now()));
for(const reduced of [false,true])for(const kind of ['fast','slow','failure','cancel','pinch','disable']){
 const context=await browser.newContext({viewport:{width:390,height:900},hasTouch:true,isMobile:true,reducedMotion:reduced?'reduce':'no-preference',serviceWorkers:'block'});
 let open=()=>{};
 try{
 const page=await context.newPage();await page.goto(runtime.origin+'/?agent=1&zoom=1800000');await page.locator('[data-time-tree]').waitFor();
 if(await page.locator('header [data-strips]').getAttribute('aria-pressed')!=='true')await page.locator('header [data-strips]').click();
 await page.locator('[data-span]').waitFor();await page.waitForTimeout(600);
 const c=await context.newCDPSession(page);
 const send=async(type:'touchStart'|'touchMove'|'touchEnd'|'touchCancel',points:{x:number;y:number;id?:number}[])=>c.send('Input.dispatchTouchEvent',{type,touchPoints:points});
 const snap=()=>page.evaluate(()=>{const m=document.querySelector<HTMLElement>('[data-pull-mark]')!,s=document.querySelector('[data-time-tree]')!.children[1] as HTMLElement,t=m.querySelector<HTMLElement>('[data-pull-turn]')!;const transform=getComputedStyle(s).transform;
 return{phase:m.dataset.phase,y:transform==='none'?0:new DOMMatrixReadOnly(transform).m42,inline:s.style.transform,reserve:s.style.willChange,opacity:getComputedStyle(m).opacity,animations:s.getAnimations().length,spin:getComputedStyle(t).animationName};});
 const calls:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname==='/api/events')calls.push(r.url())});
 const gate=new Promise<void>(done=>{open=done});
 if(kind==='slow')await page.route('**/api/events',async r=>{await gate;await r.continue()});
 if(kind==='failure')await page.route('**/api/events',r=>r.fulfill({status:503,body:'synthetic refresh failure'}));
 await send('touchStart',[{x:195,y:300}]);
 for(let i=1;i<=15;i++){await send('touchMove',[{x:195,y:300+i*18}]);await page.waitForTimeout(16)}
 assert.equal((await snap()).phase,'armed');
 if(kind==='pinch')await send('touchStart',[{x:195,y:570,id:0},{x:245,y:570,id:1}]);
 await send(kind==='cancel'?'touchCancel':'touchEnd',[]);
 const released=await snap();
 if(kind==='slow'){
 await page.waitForTimeout(750);const held=await snap();assert.equal(held.phase,'refreshing');assert(Math.abs(held.y-52)<.01);assert.equal(held.animations,0);
 // A new touch remains an ordinary touch during refresh; it never changes the displayed offset or starts another refresh.
 const count=calls.length;await send('touchStart',[{x:195,y:300}]);await send('touchMove',[{x:195,y:340}]);const grabbed=await snap();await send('touchEnd',[]);
 assert.equal(grabbed.y,held.y);assert.equal(calls.length,count);if(reduced)assert.equal(grabbed.spin,'none');
 open();results.push({reduced,kind,held,grabbed});
 }
 if(kind==='disable'){
 await context.setOffline(true);await page.waitForFunction(()=>{const m=document.querySelector<HTMLElement>('[data-pull-mark]');return !m||m.dataset.phase==='rest'});
 await context.setOffline(false);await page.waitForTimeout(800);
 const state=await page.locator('[data-time-tree]').evaluate(el=>({transform:(el.children[1] as HTMLElement).style.transform,animations:el.children[1]!.getAnimations().length}));assert.equal(state.transform,'');assert.equal(state.animations,0);results.push({reduced,kind,state});continue;
 }
 if(kind==='fast'&&!reduced){
 await page.waitForFunction(()=>{const m=document.querySelector<HTMLElement>('[data-pull-mark]')!,s=document.querySelector('[data-time-tree]')!.children[1]!;return m.dataset.phase==='done'&&s.getAnimations().length>0});
 const before=await snap();const count=calls.length;await send('touchStart',[{x:195,y:300}]);await send('touchMove',[{x:195,y:340}]);const during=await snap();await send('touchEnd',[]);
 assert.equal(calls.length,count);assert(during.y<=before.y+.5);results.push({reduced,kind,returnTouch:{before,during}});
 }
 await page.waitForFunction(()=>document.querySelector<HTMLElement>('[data-pull-mark]')?.dataset.phase==='rest',null,{timeout:20000});
 const rest=await snap();assert.equal(rest.y,0);assert.equal(rest.reserve,'');assert.equal(rest.animations,0);assert.equal(rest.opacity,'0');
 if(kind==='cancel'||kind==='pinch')assert.equal(calls.length,0);
 if(reduced)assert.equal(released.animations,0);
 // Native popup stays native and keyboard-operable.
 const select=page.locator('[data-span]'),value=await select.inputValue();await select.click();await page.screenshot({path:out+`/${reduced}-${kind}-native.png`});await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');const selected=await select.inputValue();assert.notEqual(selected,value);await select.selectOption(value);
 results.push({reduced,kind,released,rest,refreshRequests:calls.length,native:{value,selected}});
 }finally{open();await context.close()}
}
}finally{await browser.close();await runtime?.stop();writeFileSync(out+'/results.json',JSON.stringify(results,null,2))}
