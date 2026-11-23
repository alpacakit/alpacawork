/** List updates, strips, bar, pull, and tree observation. Run after build; all children have keeper expiry. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { seedTimelineScroll } from '../fixture/timeline-scroll.ts';
import { commandFetch as fetch } from '../../tests/helpers/command-fetch.ts';
import { installProbe, measurer } from './list-motion-probe.ts';
const { values: args, positionals } = parseArgs({ allowPositionals:true, options: {
 throttle:{type:'string',default:'1'}, rounds:{type:'string',default:'3'}, widths:{type:'string',default:'1440,390'},
 trace:{type:'boolean',default:false}, film:{type:'boolean',default:false}, reduced:{type:'boolean',default:false}, slow:{type:'string',default:''}, video:{type:'boolean',default:false},
} });
const output=resolve(positionals[0] ?? '/tmp/list-motion.json'); mkdirSync(dirname(output),{recursive:true});
const results:unknown[]=[]; const browser=await chromium.launch();
const expiry=setTimeout(()=>{console.error('list-motion expired');process.exit(3)},18*60_000);
try { for(const width of args.widths.split(',').map(Number)) {
 const runtime=await start(undefined, root=>{seedTimelineScroll(root);patchTask(root,'T114',{userRequested:true});},resolve('.local/list-motion-runtime',basename(output)+'-'+width+'-'+Date.now()));
 const context=await browser.newContext({viewport:{width,height:900},hasTouch:true,isMobile:width<700,locale:'en-US',timezoneId:'Asia/Tokyo',serviceWorkers:'block',reducedMotion:args.reduced?'reduce':'no-preference',...(args.video?{recordVideo:{dir:output+'.video-'+width,size:{width,height:900}}}:{})});
 try {
 const page=await context.newPage(); await installProbe(page);
 const run=await measurer(page,context,{output,width,throttle:Number(args.throttle),film:args.film,trace:args.trace,extra:{reduced:args.reduced}},results);
 const post=async(path:string,body:object)=>{const response=await fetch(runtime.origin+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 await page.goto(runtime.origin+'/?agent=1&zoom=1800000');
 await page.locator('[data-time-tree]').waitFor();
 const strips=page.locator('header [data-strips]');if(width<700&&await strips.getAttribute('aria-pressed')!=='true')await strips.click();
 await page.locator('[data-time-clock]').waitFor();
 await page.waitForTimeout(1800);
 // Expose enough inert rows to scroll, and enough notes for the real update path.
 const more=page.locator('[data-group-more=review] button');if(await more.count()&&await more.getAttribute('aria-expanded')!=='true')await more.click();
 await page.waitForTimeout(800);
 // Keep the new row's section visible without putting it below 64 review rows.
 if(await more.count() && await more.getAttribute('aria-expanded')==='true')await more.click();
 await page.waitForTimeout(400);
 const list=page.locator('[data-time-tree]');
 for(let round=0;round<Number(args.rounds);round++){
  await list.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(400);
  if(args.slow)await page.evaluate(ms=>document.documentElement.style.setProperty('--motion-base',ms+'ms'),args.slow);
  await run('update-'+round,900,async()=>{
   const view=await(await fetch(runtime.origin+'/api/task/view?task=T2063')).json();
   await post('commands/task/update',{task:'T2063',title:'Scroll review updated '+round,expectedTaskHash:view.task.hash});
   await page.locator('[data-row=T2063] [data-row-label]').filter({hasText:'Scroll review updated '+round}).waitFor();
  });
  await page.locator('[data-section=todo]').scrollIntoViewIfNeeded();await page.waitForTimeout(450);
  let arrived:any;
  await run('arrive-'+round,800,async()=>{
   const made=arrived=await post('commands/task/new',{parent:'P1',title:'List arrival '+round,fromUser:true});
   await page.locator('[data-row="'+made.task.id+'"] [data-row-label]').waitFor();
  });
  await run('move-'+round,800,async()=>{await post('commands/task/report',{opId:crypto.randomUUID(),task:arrived.task.id,state:'held',title:'Hold the arriving task',description:'List motion probe',expectedTaskHash:arrived.task.hash});await page.locator('[data-row="'+arrived.task.id+'"]').waitFor();});
  await page.locator('[data-span]').selectOption('3600000');await page.waitForTimeout(500);
  await run('zoom-'+round,700,async()=>{await page.locator('[data-span]').selectOption('1800000');});
  await list.focus();await page.keyboard.press('n');await page.waitForTimeout(600);
  await run('edge-'+round,1000,async()=>{const moved=await list.evaluate(el=>{const before=el.scrollLeft;el.scrollLeft=Math.max(0,before-250);return before-el.scrollLeft});assert.ok(moved>50,'axis pans');});
  if(width<700){
   if(await more.count()&&await more.getAttribute('aria-expanded')!=='true')await more.click();await page.waitForTimeout(400);
   await list.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(400);
   await run('bar-hide-'+round,600,async()=>{await list.evaluate(el=>{el.scrollTop=200});await page.waitForTimeout(60);await list.evaluate(el=>{el.scrollTop=400});});
   assert.equal(await page.locator('[data-bar]').getAttribute('data-bar'),'hidden');
   await run('bar-show-'+round,600,async()=>{await list.evaluate(el=>{el.scrollTop=250});});
   await list.evaluate(el=>{el.scrollTop=0});await page.waitForTimeout(400);
   const cdp=await context.newCDPSession(page);
   await run('pull-'+round,1600,async()=>{
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:300}]});
    for(let i=1;i<=20;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y:300+i*15}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   });await cdp.detach();
  }
 }
 await page.screenshot({path:output+'.'+width+'.png',animations:'disabled'});
 }finally{await context.close();await runtime.stop();}
 }}finally{clearTimeout(expiry);await browser.close();}
