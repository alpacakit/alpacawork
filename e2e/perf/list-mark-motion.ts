/** A fresh requested task each repetition supplies its own report row in the flat list. */
import assert from 'node:assert/strict';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { commandFetch as fetch } from '../../tests/helpers/command-fetch.ts';
import { installProbe, measurer } from './list-motion-probe.ts';
import { setStrips } from './bar-entries.ts';
const output=resolve(process.argv[2]!);const throttle=Number(process.argv[3]??1);mkdirSync(dirname(output),{recursive:true});
const browser=await chromium.launch(), results:unknown[]=[];const expiry=setTimeout(()=>process.exit(3),10*60_000);
try{for(const width of [1440,390]){
 const runtime=await start(undefined,undefined,resolve('.local/list-motion-runtime',basename(output)+'-'+width+'-'+Date.now()));
 try{for(let round=0;round<3;round++){
  const post=async(path:string,data:object)=>{const r=await fetch(runtime.origin+'/api/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  const made=await post('commands/task/new',{parent:'P1',title:'Visible new report '+round,fromUser:true});
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:true,isMobile:width<700,locale:'en-US',timezoneId:'Asia/Tokyo',serviceWorkers:'block'});
  try{const page=await context.newPage();await installProbe(page);await page.goto(runtime.origin+'/?agent=1&zoom=1800000');await page.locator('[data-time-tree]').waitFor();
   if(width<700)await setStrips(page,true);
   await page.locator('[data-time-clock]').waitFor();await page.waitForTimeout(1000);
   await page.evaluate(taskId=>{
    (window as any).newMarkSamples=[]; (window as any).newMarkGlyphs=[];
    const animate=Element.prototype.animate;
    Element.prototype.animate=function(frames,options){
     if(JSON.stringify(frames).includes('scale')){
      const glyph=this.matches('[data-mark]')?this:this.querySelector('[data-mark]');
      if(glyph){
       (window as any).newMarkGlyphs.push(glyph);
       (window as any).newMarkSamples.push({task:glyph.closest('[data-row]')?.getAttribute('data-row'),mark:glyph.getAttribute('data-mark'),target:this.tagName,expected:taskId});
      }
     }
     return animate.call(this,frames,options);
    };
   },made.task.id);
   let samples:any[]=[];
   const run=await measurer(page,context,{output,width,throttle,extra:{freshTaskScope:true}},results);
   const measured=await run('new-mark-'+round,650,async()=>{await post('commands/task/report',{task:made.task.id,state:'done',title:'New report',description:'Visible new report',opId:crypto.randomUUID(),expectedTaskHash:made.task.hash});
    await page.waitForFunction(()=>window.listMotion.animations.some(a=>a.props.includes('scale')));samples=await page.evaluate(()=>(window as any).newMarkSamples);},animations=>animations.filter(a=>a.props.includes('scale')).length===1 && samples.length===1 && samples.every(s=>s.task===made.task.id));
   // Geometry is read after the measured interval; it cannot add a layout to that interval.
   const visible=await page.evaluate(()=>(window as any).newMarkGlyphs.map((glyph:Element)=>{
    const box=glyph.getBoundingClientRect(),list=glyph.closest('[data-time-tree]')?.getBoundingClientRect();
    return glyph.isConnected && !!list && box.width>0 && box.height>0 && Math.min(box.right,list.right,innerWidth)>Math.max(box.left,list.left,0) && Math.min(box.bottom,list.bottom,innerHeight)>Math.max(box.top,list.top,0);
   }));
   measured.valid=measured.valid && visible.length===1 && visible.every(Boolean);
   measured.markEvidence={samples,visible};
   writeFileSync(output,JSON.stringify({version:1,browser:browser.version(),throttle,results},null,2));
   assert.ok(measured.valid,'one visible mark of this task must actually scale');
   console.log('new mark target',JSON.stringify({samples,visible}));
  }finally{await context.close();}
 }}finally{await runtime.stop();}
}}finally{clearTimeout(expiry);await browser.close();}
