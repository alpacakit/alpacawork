/** A URL task is looked up in the same reader, with explicit failure and recovery controls. */
import type { Page } from '@playwright/test';
import {test,expect,open} from './fixtures.ts';
import {SAMPLE_PROJECT} from './fixture/sample.ts';
const waitAddress='**/api/task/view?task=T999';
const failed={error:{code:'io_failure',message:'Scope lookup unavailable',retry:'later'}};
const reader=(page:Page)=>page.locator('aside[data-reader-mode]');
async function waiting(page:Page,runtime:{origin:string},query:string){
 const feed=page.waitForResponse((r)=>new URL(r.url()).pathname==='/api/events');
 await page.goto(runtime.origin+'/?agent=1&'+query);expect((await feed).status()).toBe(200);
 await expect(page.getByRole('heading',{name:SAMPLE_PROJECT.title,level:1})).toBeVisible();
}

test('a task whose lookup fails asks again; one the server does not know closes only the reader',async({page,runtime})=>{
 await page.setViewportSize({width:1440,height:900});let attempts=0;
 await page.route(waitAddress,async route=>{attempts++;if(attempts===1)await route.fulfill({status:503,json:failed});else await route.continue();});
 await open(page,runtime,'?agent=1&task=T999');
 await expect(reader(page).getByRole('alert')).toContainText('Could not read the task');
 await reader(page).getByRole('button',{name:'Retry',exact:true}).click();
 await expect(reader(page)).toHaveCount(0);
});

test('a read the server stays silent on until its deadline asks again by itself, with no failure on the screen',async({page,runtime})=>{
 await page.setViewportSize({width:1440,height:900});
 let attempts=0;
 await page.route('**/api/task/view?task=T112',async route=>{if(attempts++===0)return;await route.continue();});
 await page.addInitScript(()=>{const w=window as unknown as {alerted:boolean};w.alerted=false;new MutationObserver(()=>{if(document.querySelector('aside[data-reader-mode] [data-read-failure]'))w.alerted=true;}).observe(document,{subtree:true,childList:true});});
 await open(page,runtime,'?agent=1&task=T112');
 await expect(reader(page).locator('[data-report-feed]')).toBeVisible({timeout:20_000});
 expect(attempts).toBe(2);
 expect(await page.evaluate(()=>(window as unknown as {alerted:boolean}).alerted)).toBe(false);
});
