/** Record the same heavy-data interactions before and after. Annotation is an optional separate pass. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { conversation, startPanelFixture, preparePanel, ensureConversation, PANEL_DRAFT, readPanelDraft } from './panel-fixture.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';

const output = resolve(process.argv[2] ?? '/tmp/panel-videos');
const helper = process.argv[3];
if (!helper) throw Error('Pass the askmeclearly scripts/video-marks.mjs path as the second argument');
const { openMarkedPage } = await import(pathToFileURL(resolve(helper)).href);
mkdirSync(output, { recursive: true });
const runtime = await startPanelFixture(true);
const browser = await chromium.launch().catch(async error => { await runtime.stop(); throw error; });
const expiry = setTimeout(() => { void browser.close().finally(() => runtime.stop()); }, 8 * 60_000);
try {
  for (const width of [1440, 390]) {
    const viewport = { width, height:900 };
    const context = await browser.newContext({ viewport, hasTouch:width<900, locale:'en-US', timezoneId:'Asia/Tokyo', serviceWorkers:'block', recordVideo:{ dir:output, size:viewport } });
    const { page, marks }: { page: Page; marks: { caption: (text: string) => void; box: (box: unknown, label: string, options: { seconds: number }) => void; clear: () => void; save: (path: string, options: { input: string; output: string }) => Promise<void> } } = await openMarkedPage(context);
    page.setDefaultTimeout(12000);
    await page.clock.setFixedTime(new Date(SAMPLE_NOW));
    await page.addInitScript(() => localStorage.setItem('alpacawork.coordinatorExtent', '240'));
    await page.route('**/api/coordinator', route => route.fulfill({ json:conversation }));
    await page.route('**/api/coordinator/warm', route => route.fulfill({ json:conversation }));
    await page.goto(runtime.origin+'/?agent=1&strip=on');
    await page.locator('[data-read="T111"]').first().waitFor();
    await page.waitForTimeout(1200);
    await ensureConversation(page, true);
    await page.mouse.move(width<900 ? 100 : 500, 200);
    marks.caption('① 詳細を開く — 会話と入力を開いた大きな履歴');
    marks.box(await page.locator('[data-read="T111"]').first().boundingBox(), '詳細を開く', { seconds:3 });
    await page.waitForTimeout(1500);
    await page.locator('[data-read="T111"]').first().click();
    await preparePanel(page, true);
    await ensureConversation(page);
    await page.waitForTimeout(1200);
    marks.clear();
    marks.caption('② 詳細を連続リサイズし、途中で反転する');
    if (width>900) {
      const edge=await page.locator('[data-reader-width]').boundingBox();
      const y=edge!.y+edge!.height/2;
      marks.box({x:edge!.x,y:150,width:80,height:500},'詳細の端',{seconds:6});
      await page.waitForTimeout(1500);
      await page.mouse.move(edge!.x+8,y,{steps:25}); await page.mouse.down();
      for(const x of [700,576,480,576,700,820]) await page.mouse.move(x,y,{steps:20});
      await page.mouse.up();
    } else {
      await page.locator('[data-reader-content]').evaluate(el => { el.scrollTop = 0; }); await page.waitForTimeout(450);
      const grip=await page.locator('[data-task-sheet-grip]').boundingBox();
      const x=width/2,y=grip!.y+grip!.height/2;
      marks.box(grip,'詳細のグリップ',{seconds:6});
      await page.waitForTimeout(1500);
      const cdp=await context.newCDPSession(page);
      await page.mouse.move(x,y,{steps:20});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      for(let step=1;step<=24;step++) { const offset=step<=12?-step*8:-(24-step)*8; await page.mouse.move(x,y+offset); await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+offset}]}); await page.waitForTimeout(35); }
      await page.waitForTimeout(160); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await cdp.detach();
    }
    await page.waitForTimeout(1800);
    marks.clear();
    marks.caption('③ 画面幅を変える — 詳細と時間軸が追従');
    await page.waitForTimeout(1500);
    for (const delta of [-40,-80,-120,-80,-40,0]) {
      await page.setViewportSize({ width: width + delta, height: 900 });
      await page.waitForTimeout(180);
    }
    await page.waitForTimeout(1400);
    marks.clear();
    marks.caption('④ 詳細を閉じる — 下書きを保持');
    await page.locator('[data-reader-content]').evaluate(el=>{el.scrollTop=0;}); await page.waitForTimeout(450);
    const close=page.getByRole('button',{name:'Close details',exact:true});
    marks.box(await close.boundingBox(),'詳細を閉じる',{seconds:3});
    await page.waitForTimeout(1500); await close.click(); await page.waitForTimeout(1200);
    if(width<900) {
      marks.clear(); marks.caption('⑤ Timeを閉じ、開き直す');
      const toggle=page.locator('header [data-strips]');
      marks.box(await toggle.boundingBox(),'Time',{seconds:5});
      await page.waitForTimeout(1500); await toggle.click(); await page.waitForTimeout(1400); await toggle.click(); await page.waitForTimeout(1600);
    } else {
      marks.clear(); marks.caption('⑤ 時間軸を拡大し、元の範囲へ戻す');
      marks.box({x:360,y:56,width:500,height:180},'時間軸',{seconds:5});
      await page.waitForTimeout(1500); await page.locator('[data-time-tree]').focus();
      for(const key of ['+','+','+','-','-','-']) { await page.keyboard.press(key); await page.waitForTimeout(180); }
      await page.waitForTimeout(1600);
    }
    marks.clear(); marks.caption('⑥ 会話と入力を開き直す — 下書きが残る');
    await page.waitForTimeout(1500);
    await ensureConversation(page);
    marks.box(await page.locator('[data-one-input]').boundingBox(),'保持された下書き',{seconds:2});
    await page.waitForTimeout(2000);
    const draft=await readPanelDraft(page);
    if(draft!==PANEL_DRAFT) throw Error('Video scenario lost its draft');
    await page.screenshot({path:join(output,`${width}-end.png`)});
    writeFileSync(join(output,`${width}-state.json`),JSON.stringify({width,draft,url:page.url()},null,2));
    marks.clear();
    const video=page.video()!;
    await context.close(); await video.saveAs(join(output,`${width}-raw.webm`));
    await marks.save(join(output,`${width}-marks.json`),{input:`${width}-raw.webm`,output:`${width}-marked.mp4`});
  }
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
