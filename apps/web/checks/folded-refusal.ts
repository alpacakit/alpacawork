import { seedTask } from '../../../e2e/fixture/tasks.ts';
/** 390px self-check: a refused folded send reveals the existing sender error without changing the source intent. */
import { chromium, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { start } from '../../../e2e/server.ts';
import { startFakeCoordinator } from '../../../e2e/coordinator-fixture.ts';
import { patchTask, seedReview } from '../../../e2e/fixture/task-state.ts';
import { readTaskLog } from '../../../e2e/task-history.ts';
import { commandFetch as fetch } from '../../../tests/helpers/command-fetch.ts';
const evidence=resolve(process.env.ALPACAWORK_UI_EVIDENCE??'/tmp/alpacawork-folded-refusal');mkdirSync(evidence,{recursive:true});
const runtime=await start(undefined,startFakeCoordinator),browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:390,height:844},locale:'en-US',serviceWorkers:'block'}),posts:any[]=[],steps:any[]=[];
page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/coordinator/messages'))posts.push(request.postDataJSON());});
const reader=page.locator('aside[data-reader-mode]'),input=page.locator('[data-one-input]'),capsule=page.locator('[data-coordinator-capsule]');
const reason='The task has changed. Choose its state again';
async function get(path:string){const response=await fetch(`${runtime.origin}/api/${path}`);expect(response.status,await response.clone().text()).toBe(200);return response.json();}
async function post(path:string,body:object){const response=await fetch(`${runtime.origin}/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});expect(response.status,await response.clone().text()).toBe(200);return response.json();}
async function task(parent:string,title:string){const task=seedTask(runtime.root,parent,title);await post('commands/agent/assign',{task:task.id,role:'responsible',profile:'codex',expectedTaskHash:task.hash});patchTask(runtime.root,task.id,{state:'doing'});return task.id as string;}
async function editable(source:string){return page.evaluate(id=>{const saved=JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')??'{}');return Object.values(saved.entries??{}).map((entry:any)=>entry.values).find((values:any)=>values.readerIntent&&JSON.parse(values.readerIntent).task===id);},source);}
async function shot(name:string){await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});await page.screenshot({path:join(evidence,name),animations:'disabled'});}
async function prepare(direct:string,source:string){
 await expect.poll(async()=>(await get(`task/view?address=${direct}`)).userReviews.some((review:any)=>review.taskId===source)).toBe(true);
 const record=(await get(`task/view?address=${direct}`)).userReviews.find((review:any)=>review.taskId===source).id;
 const card=reader.locator(`[data-report-key="log:${source}:${record}"]`);await expect(card).toBeVisible();const heading=card.locator('button[aria-expanded]').first();if(await heading.getAttribute('aria-expanded')==='false')await heading.click();
 await expect(card.getByRole('button',{name:'Write a send-back'})).toBeEnabled();await card.getByRole('button',{name:'Write a send-back'}).click();await expect(input).toBeVisible();await input.press('End');await input.type(' Please revise the original result.');const values=await editable(source);expect(values).toBeTruthy();
 await input.press('Escape');await expect(capsule).toBeVisible();await expect(input).toHaveCount(0);return {record,values};
}
try{
 const project=(await post('commands/task/new',{kind:'project',color:'#39659b',parent:'none',title:'Folded refusal local fixture'})).task.id,direct=await task(project,'Direct display'),middle=await task(direct,'Middle owner');
 const stale=await task(middle,'Original review before revision');seedReview(runtime.root,stale,{title:'Original result ready'});
 await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${direct}`);
 const captured=await prepare(direct,stale),oldIntent=JSON.parse(captured.values.readerIntent);
 const refreshed=page.waitForResponse(async response=>response.url().includes(`/api/task/view?task=${stale}`)&&response.ok()&&(await response.json()).task.hash!==oldIntent.expectedTaskHash);
 patchTask(runtime.root,stale,{body:'The original Task changed after folding the prepared send-back.'});await refreshed;
 await expect(page.getByText(reason,{exact:true})).toHaveCount(0);await shot('C3-before-folded-phone.png');
 await capsule.locator('[data-ask-send]').click();await expect(input).toBeVisible();await expect(page.getByText(reason,{exact:true})).toBeVisible();await expect(capsule).toHaveCount(0);expect(posts).toEqual([]);
 const after=await editable(stale);expect(after.readerIntent).toBe(captured.values.readerIntent);expect(after.readerIntentTurn).toBe(captured.values.readerIntentTurn);expect(after.doc).toBe(captured.values.doc);await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 await shot('C3-refusal-visible-phone.png');steps.push({step:'390px: prepare source send-back, Esc fold, source revision, Capsule send reveals the same sender error with POST0 and unchanged intent/turn/document',stale,record:captured.record,originalIntent:oldIntent,currentHash:(await get(`commands/task/get?task=${stale}`)).task.hash,before:captured.values,after});
 await input.press('ControlOrMeta+A');await input.press('Backspace');
 const source=await task(middle,'Unchanged original review');seedReview(runtime.root,source,{title:'Result to send back successfully'});const before=await get(`commands/task/get?task=${source}&runs=100`),success=await prepare(direct,source);
 await capsule.locator('[data-ask-send]').click();await expect.poll(()=>posts.length).toBe(1);await expect(capsule).toBeVisible();await expect(input).toHaveCount(0);expect(posts[0].intent).toEqual(JSON.parse(success.values.readerIntent));expect(posts[0].tasks).toEqual([source]);
 await expect.poll(async()=>(await readTaskLog(runtime.origin,source)).filter(entry=>entry.kind==='review_sent_back').length,{timeout:25000}).toBe(1);await expect.poll(async()=>(await get(`commands/task/get?task=${source}&runs=100`)).runs.length).toBe(before.runs.length+1);
 await expect(capsule).toBeVisible();await expect(input).toHaveCount(0);await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);await shot('C3-success-folded-phone.png');steps.push({step:'390px: successful source send-back retains fold, source intent and direct reader; one record and resumed source Run',source,record:success.record,intent:posts[0].intent,sourceRuns:(await get(`commands/task/get?task=${source}&runs=100`)).runs});
 writeFileSync(join(evidence,'browser.json'),JSON.stringify({ok:true,root:runtime.root,steps,posts},null,2));console.log(JSON.stringify({ok:true,steps:steps.length,evidence}));
}catch(error){await page.screenshot({path:join(evidence,'browser-failure.png')}).catch(()=>{});writeFileSync(join(evidence,'browser-failure.json'),JSON.stringify({error:String(error),steps,posts,body:await page.locator('body').innerText().catch(()=> '')},null,2));throw error;}
finally{await page.close();await browser.close();await runtime.stop();}
