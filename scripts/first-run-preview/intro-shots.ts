/**
 * The introduction's pictures (apps/web/src/features/intro/shots), taken from the real screens of the disposable
 * preview: its setup, then two of the welcome's examples sent to the stand-in AI, so the list holds one Task being
 * worked on and one awaiting the person. Which pictures there are, and which parts each one numbers, is read from the
 * introduction's own definition; this file only says how the screen is brought to each picture's state (SCENES).
 *
 *   node scripts/try-first-run.ts --intro-shots --lang ja      (then again with --lang en)
 */
import assert from 'node:assert/strict';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SLIDES } from '../../apps/web/src/features/intro/intro-definition.ts';

/** The size a picture is taken at: a computer's window in the dialog's own proportions, or a phone. */
const DESKTOP = { viewport: { width: 1200, height: 750 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

type Scene = { url: string; project: string; waiting: string; working: string; choice: RegExp };
/** How the screen is brought to each picture's state, by the picture's name (a slide's `shot`). */
const SCENES: Record<string, { phone?: boolean; set: (page: Page, scene: Scene) => Promise<void> }> = {
  // The list alone: one Task being worked on, one awaiting the person.
  flow: { set: async (page, scene) => {
    await page.goto(`${scene.url}?project=${scene.project}`);
    await rows(page, scene);
  } },
  // The Task awaiting the person, open in the detail beside the list.
  parts: { set: async (page, scene) => {
    await page.goto(`${scene.url}?project=${scene.project}&task=${scene.waiting}`);
    await rows(page, scene);
    await page.locator('[data-question="1"]').waitFor();
  } },
  // The same, with a choice picked: it waits in the input to be sent.
  turn: { set: async (page, scene) => {
    await page.goto(`${scene.url}?project=${scene.project}&task=${scene.waiting}`);
    await rows(page, scene);
    await page.locator('[data-question="1"]').getByRole('button', { name: scene.choice }).click();
    await page.locator('[data-ask-send]:not(.sr-only):not(:disabled)').waitFor();
  } },
  // The list on a phone.
  phone: { phone: true, set: async (page, scene) => {
    await page.goto(`${scene.url}?project=${scene.project}`);
    await rows(page, scene);
  } },
};
const rows = async (page: Page, scene: Scene) => {
  for (const id of [scene.working, scene.waiting]) await page.locator(`[data-row="${id}"]`).first().waitFor();
};

/**
 * Rings each numbered part and writes its number on it, over the page, in the colour the dialog's own numbers have.
 * A part is everything on the screen its selector finds, ringed as one; one that is not there fails the capture, so a
 * picture never goes out with a number missing.
 */
async function mark(page: Page, parts: readonly (string | undefined)[]) {
  const missing = await page.evaluate((parts) => {
    const colour = getComputedStyle(document.documentElement).getPropertyValue('--turn') || '#b45309';
    const missing: string[] = [];
    const put = (style: string, text = '') => {
      const element = document.createElement('div');
      element.dataset.introMark = ''; element.textContent = text;
      element.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' + style;
      document.documentElement.append(element);
    };
    parts.forEach((part, index) => {
      if (!part) return;
      const boxes = [...document.querySelectorAll<HTMLElement>(part)].map(element => element.getBoundingClientRect())
        .filter(box => box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight);
      if (!boxes.length) { missing.push(part); return; }
      // The ring stands a little clear of the part, and inside the picture's edge.
      const edge = 5, room = 5, size = 32;
      const left = Math.max(edge, Math.min(...boxes.map(box => box.left)) - room), top = Math.max(edge, Math.min(...boxes.map(box => box.top)) - room);
      const right = Math.min(innerWidth - edge, Math.max(...boxes.map(box => box.right)) + room), bottom = Math.min(innerHeight - edge, Math.max(...boxes.map(box => box.bottom)) + room);
      put(`left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;border:3px solid ${colour};border-radius:10px;`);
      // The number sits on the ring's top left corner, mostly outside it, so it covers little of the part.
      put(`left:${Math.max(2, left - size * 0.7)}px;top:${Math.max(2, top - size * 0.7)}px;width:${size}px;height:${size}px;border-radius:50%;background:${colour};color:#fff;font:700 18px/${size}px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 3px #fff;`, String(index + 1));
    });
    return missing;
  }, parts);
  assert.deepEqual(missing, [], 'Parts the introduction numbers are not on the screen');
}

/** Sends `words` from the input and waits for the Task the stand-in AI makes for them; returns that Task's ID. */
async function request(page: Page, root: string, send: () => Promise<void>, write: () => Promise<void>) {
  const tasks = () => existsSync(join(root, 'actor-files')) ? readdirSync(join(root, 'actor-files')).filter(name => /^T\d+\.json$/.test(name)) : [];
  const before = tasks();
  await write(); await send();
  for (let n = 0; n < 200; n++) {
    const made = tasks().find(name => !before.includes(name));
    if (made) return made.replace('.json', '');
    if (existsSync(join(root, 'actor-errors.log'))) throw new Error(readFileSync(join(root, 'actor-errors.log'), 'utf8'));
    await delay(100);
  }
  throw new Error('The stand-in AI made no Task for the request');
}

export async function captureIntroShots(url: string, root: string, language: string, out: string) {
  const en = language === 'en';
  const marker = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8'));
  // How long the stand-in AI works before it asks or reports: short for the first Task, so its question arrives; then
  // long, so the second Task is still being worked on in every picture.
  const works = (ms: number) => writeFileSync(join(root, 'preview.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8')), exampleDelayMs: ms }));
  const browser = await chromium.launch({ headless: true });
  const open = async (context: BrowserContext) => {
    // The pictures are of the screen itself, so the introduction stays shut; and nothing leaves the preview.
    await context.addInitScript(() => localStorage.setItem('alpacawork.introSeen', '1'));
    const page = await context.newPage();
    page.setDefaultTimeout(40_000);
    await page.route('**/*', route => {
      const target = new URL(route.request().url());
      return target.origin === new URL(url).origin || target.protocol === 'data:' ? route.continue() : route.abort();
    });
    return page;
  };
  try {
    const page = await open(await browser.newContext({ ...DESKTOP, locale: language }));
    const get = async (path: string) => { const response = await page.request.get(new URL(path, url).href); assert.equal(response.ok(), true, await response.text()); return response.json(); };
    const send = () => page.getByRole('region', { name: en ? 'Coordinator' : 'コーディネーター', exact: true })
      .getByRole('button', { name: en ? 'Send' : '送る', exact: true }).click();

    // The setup's three steps, as a new person takes them.
    await page.goto(url);
    const setup = page.locator('[data-setup-screen]');
    await setup.locator('[data-setup-panel="agents"] [data-setup-next]').click();
    await setup.locator('[data-setup-panel="skills"] [data-setup-install]').click();
    const project = setup.locator('[data-setup-panel="project"]');
    await project.waitFor();
    const folder = join(root, 'project'); mkdirSync(folder);
    await project.locator('#project-name').fill(en ? 'My app' : 'わたしのアプリ');
    await project.locator('#project-location').fill(folder);
    await project.locator('#project-location').press('Tab');
    await project.locator('[data-setup-finish]').click();
    await page.locator('[data-welcome]').waitFor();
    const scene: Scene = { url, project: (await get('/api/first-run')).state.project, waiting: '', working: '', choice: en ? /Memory match/ : /神経衰弱/ };

    // One example whose Task comes to ask a question, then another that stays being worked on.
    works(1500);
    scene.waiting = await request(page, root, send, () => page.locator('[data-welcome-example="decide"]').click());
    await assert.doesNotReject(async () => {
      for (let n = 0; n < 300; n++) {
        if ((await get(`/api/task/get?task=${scene.waiting}`)).questions.some((question: { state: string }) => question.state === 'open')) return;
        await delay(100);
      }
      throw new Error('The first Task asked no question');
    });
    works(15 * 60_000);
    const words = marker.examples.find((example: { name: string }) => example.name === 'models').words as string;
    scene.working = await request(page, root, send, async () => { await page.locator('[data-one-input]').click(); await page.keyboard.insertText(words); });

    mkdirSync(out, { recursive: true });
    const phone = await open(await browser.newContext({ ...PHONE, locale: language }));
    for (const shot of new Set(SLIDES.map(slide => slide.shot))) {
      const how = SCENES[shot];
      assert.ok(how, `No scene for the picture “${shot}”: add one to SCENES`);
      const at = how.phone ? phone : page;
      await how.set(at, scene);
      // What the conversation's last line and the rows say settles a moment after the page is drawn.
      await delay(1200);
      await mark(at, SLIDES.filter(slide => slide.shot === shot).flatMap(slide => slide.points.map(point => point.part)));
      await at.screenshot({ path: join(out, `${language}-${shot}.png`) });
      await at.evaluate(() => document.querySelectorAll('[data-intro-mark]').forEach(element => element.remove()));
      console.log(`Took ${language}-${shot}.png`);
    }
  } catch (error) {
    if (existsSync(join(root, 'actor-errors.log'))) console.error(readFileSync(join(root, 'actor-errors.log'), 'utf8'));
    throw error;
  } finally { await browser.close(); }
}
