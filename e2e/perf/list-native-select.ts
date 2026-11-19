/** Isolated causal comparison. Removing only the period select is a diagnostic, not a product change.
 * PC has neither auto-hide nor pull; its header is moved artificially and labelled as such. */
import assert from 'node:assert/strict';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { seedTimelineScroll } from '../fixture/timeline-scroll.ts';
import { installProbe, measurer } from './list-motion-probe.ts';
const output=resolve(process.argv[2]!);const throttle=Number(process.argv[3]??1);mkdirSync(dirname(output),{recursive:true});
const results:unknown[]=[];const browser=await chromium.launch();const expiry=setTimeout(()=>process.exit(3),10*60_000);
try { for(const width of [1440,390]) {
 const runtime=await start(undefined,seedTimelineScroll,resolve('.local/list-motion-runtime',basename(output)+'-'+width+'-'+Date.now()));
 try{for(const select of ['present','removed']){
 const context=await browser.newContext({viewport:{width,height:900},hasTouch:true,isMobile:width<700,locale:'en-US',timezoneId:'Asia/Tokyo',serviceWorkers:'block'});
 try{const page=await context.newPage();await installProbe(page);await page.goto(runtime.origin+'/?agent=1&zoom=1800000');await page.locator('[data-time-tree]').waitFor();
 if(width<700)await page.locator('header [data-strips]').click();await page.locator('[data-span]').waitFor();await page.waitForTimeout(1500);
 if(select==='removed')await page.locator('[data-span]').evaluate(el=>{const box=el.getBoundingClientRect();const same=document.createElement('div');same.style.width=box.width+'px';same.style.height=box.height+'px';el.replaceWith(same)});
 const run=await measurer(page,context,{output,width,throttle,extra:{select,diagnostic:true}},results);const list=page.locator('[data-time-tree]');await list.focus();
 for(let round=0;round<3;round++){
 if(width===1440){await page.evaluate(()=>{const root=document.querySelector('[data-page]') as HTMLElement;root.style.setProperty('--bar-in','var(--bar-h)')});await page.waitForTimeout(350);await run('artificial-head-'+round,600,()=>page.evaluate(()=>{(document.querySelector('[data-page]') as HTMLElement).style.setProperty('--bar-in','0px')}));continue;}
 await list.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(400);
 await run('bar-hide-'+round,600,async()=>{await list.evaluate(el=>{el.scrollTop=200});await page.waitForTimeout(60);await list.evaluate(el=>{el.scrollTop=400})});assert.equal(await page.locator('[data-bar]').getAttribute('data-bar'),'hidden');
 await run('bar-show-'+round,600,()=>list.evaluate(el=>{el.scrollTop=250}));
 await list.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(400);const cdp=await context.newCDPSession(page);
 await run('pull-'+round,1600,async()=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:300}]});for(let i=1;i<=20;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y:300+i*15}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})});await cdp.detach();
 }
 }finally{await context.close()}
 }}finally{await runtime.stop()}
 }}finally{clearTimeout(expiry);await browser.close()}
