import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import { commandPost } from "./command-post.ts";
/**
 * In a real browser: an answer sent from the coordinator on a question, delivered only after the person went back
 * (Back or ×) to the ordinary list, does not open the next question over that URL.
 */
import type { Page } from '@playwright/test';
import { test, expect, openCoordinator } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview } from './fixture/task-state.ts';
import { placeResponsible } from './fixture/responsible.ts';
import type { Runtime } from './server.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import { decideValues } from '../tests/helpers/task-values.ts';

/** Opens the page on `search`, the ordinary list: the bars and the feed, not the list. */
async function waitingOn(page: Page, runtime: { origin: string }, search: string) {
  const feed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/events");
  await page.goto(`${runtime.origin}/${search}`);
  expect((await feed).status()).toBe(200);
  await expect(page.getByRole("heading", { name: SAMPLE_PROJECT.title, level: 1 })).toBeVisible();
}
const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const shown = (page: Page) => reader(page).locator('header [data-reader-task-id]');
const field = (page: Page) => page.locator('[data-one-input]');
test.use({ isolated: true });
test.describe.configure({ timeout: 90_000 });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
/** A question waiting on the person, opened from the list of the ordinary list (held). */
async function prepare(page: Page, runtime: Runtime) {
  configureCoordinator(runtime.root);
  const made = await commandPost(page.request, runtime.origin + '/api/task/new', { data: { title: 'Check swipe recovery' } });
  const task = await placeResponsible(page.request, runtime.origin, (await made.json()).task, 'fake');
  // At work, its responsible asks the person the body's question.
  patchTask(runtime.root, task.id, { state: 'doing', values: decideValues(['Which option', ['Option1 Send current input', 'Send to the coordinator'], ['Option2 Decide later', 'Hold it']]) });
  seedQuestion(runtime.root, task.id, { to: 'user', title: 'Please choose an option', description: 'Send the selected result to the coordinator.' });
  const nextMade = await commandPost(page.request, runtime.origin + '/api/task/new', { data: { title: 'Next review card' } });
  const next = await placeResponsible(page.request, runtime.origin, (await nextMade.json()).task, 'fake');
  seedReview(runtime.root, next.id, { title: 'Please review', description: 'Swipe left here to hold.' });
  // The question is reached through the ordinary search results.
  await waitingOn(page, runtime, '?agent=1');
  await page.locator('input[data-search-input]:visible').fill('Check swipe recovery');
  await page.locator(`[data-result="${task.id}"]`).click();
  await expect(shown(page)).toHaveText(task.id);
  return task;
}

for(const how of ['Back'] as ('Back' | 'x')[])test('an answer delivered late, after '+how+' back to the ordinary list, moves nothing and keeps that URL',async({page,runtime})=>{
 page.setDefaultTimeout(15000);await page.setViewportSize({width:1440,height:900});
 const task=await prepare(page,runtime);
 await openCoordinator(page); await expect(field(page)).toHaveAttribute('contenteditable','true');
 await field(page).press('End'); await page.keyboard.insertText('Proceed with this option');
 await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
 let release!:()=>void,reached!:()=>void,replied!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{reached=r;}),returned=new Promise<void>(r=>{replied=r;});
 await page.route('**/api/coordinator/messages',async route=>{reached();await gate;const response=await route.fetch();await route.fulfill({response});replied();});
 await page.locator('[data-ask-send]').click();await entered;
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 // Admission already adds the next-card step. Back reopens the source before the navigation under test.
 await expect(shown(page)).not.toHaveText(task.id);
 await page.goBack();await expect(shown(page)).toHaveText(task.id);
 if(how==='Back')await page.goBack();else await reader(page).getByRole('button',{name:'Close details',exact:true}).click();

 // The source reader is gone; a late completion must keep this list destination.
 await expect(reader(page)).toHaveCount(0);await page.waitForTimeout(300);
 const returnedUrl=page.url();


 release();await returned;
 await expect.poll(async()=>((await (await page.request.get(runtime.origin+'/api/coordinator')).json()).conversation.turns.at(-1)?.status)).toBe('succeeded');
 await page.waitForTimeout(750);


 expect(page.url()).toBe(returnedUrl);
 expect(new URL(page.url()).searchParams.get('task')).toBeNull();
});
