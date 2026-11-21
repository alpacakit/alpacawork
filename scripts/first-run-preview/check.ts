/** The real screens and CLI, against the disposable packaged server: the three setup steps, then an example's journey. */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function checkJourney(url: string, root: string, language: string, width = 1440) {
  const marker = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8'));
  const en = language === 'en';
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(25_000);
    // Browser requests, too, must stay in the preview. A telemetry consent is a real local record only.
    await page.route('**/*', route => {
      const target = new URL(route.request().url());
      return target.origin === new URL(url).origin || target.protocol === 'data:' ? route.continue() : route.abort();
    });
    const get = async (path: string) => {
      const response = await page.request.get(new URL(path, url).href); assert.equal(response.ok(), true, await response.text()); return response.json();
    };
    const send = () => page.getByRole('region', { name: en ? 'Coordinator' : 'コーディネーター', exact: true })
      .getByRole('button', { name: en ? 'Send' : '送る', exact: true }).click();

    // The server sends a new workspace to its setup.
    await page.goto(url + '?agent=1');
    expect(new URL(page.url()).pathname).toBe('/welcome');
    const setup = page.locator('[data-setup-screen]');
    // 1 Agents: Codex is signed in and on; Claude Code needs sign-in and has no switch. Usage data starts ticked.
    const agents = setup.locator('[data-setup-panel="agents"]');
    await expect(agents.locator('[data-setup-agent="codex"] [role=switch]')).toHaveAttribute('aria-checked', 'true');
    await expect(agents.locator('[data-setup-agent="claude"] [role=switch]')).toHaveCount(0);
    const consent = agents.locator('[data-setup-consent] input');
    await expect(consent).toBeChecked();
    await agents.locator('[data-setup-next]').click();
    // 2 Skills: the three recommended are ticked; the button names how many it installs.
    const skills = setup.locator('[data-setup-panel="skills"]');
    await expect(skills.locator('[data-setup-install]')).toHaveText(en ? 'Install 3 skills' : '3 個のスキルをインストール');
    assert.equal((await get('/api/telemetry/status')).state, 'on');
    await skills.locator('[data-setup-install]').click();
    // 3 Project: reached once every ticked skill is installed; its policy names them.
    const project = setup.locator('[data-setup-panel="project"]');
    await expect(project).toBeVisible({ timeout: 40_000 });
    for (const name of ['askmeclearly', 'doyourjob', 'alpacawork-betterquality'])
      assert.ok(existsSync(join(marker.home, '.agents/skills', name, 'SKILL.md')), `${name} was not installed`);
    assert.match(readFileSync(join(marker.home, '.agents/skills/askmeclearly/SKILL.md'), 'utf8'), /Synthetic preview/);
    await expect(project.locator('#project-policy')).toHaveValue(/askmeclearly[\s\S]*doyourjob[\s\S]*alpacawork-betterquality/);
    // A reload reopens on the step reached.
    await page.reload();
    await expect(setup.locator('[data-setup-panel="project"]')).toBeVisible();
    const folder = join(root, 'project'); mkdirSync(folder);
    await project.locator('#project-name').fill('Preview project');
    await project.locator('#project-location').fill(folder);
    await project.locator('#project-location').press('Tab');
    await project.locator('[data-setup-finish]').click();
    // The page opens on the project in the same document, and stays the page from then on.
    await expect(setup).toHaveCount(0);
    await expect(page.locator('[data-welcome]')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    const state = (await get('/api/first-run')).state;
    assert.ok(state.finishedAt, 'Setup was not recorded as finished');
    const saved = (await get(`/api/task/get?task=${state.project}`)).task;
    assert.equal(saved.title, 'Preview project');
    await page.goto(`${url}welcome?agent=1`);
    expect(new URL(page.url()).pathname).toBe('/');

    // An example from the welcome goes into the input; sent, it becomes a Task with a question, then a result.
    await page.goto(`${url}?agent=1&project=${state.project}`);
    // A new person's first look opens the introduction over the welcome: read to its end, it is closed for good.
    const intro = page.locator('[data-intro]');
    await expect(intro).toBeVisible();
    while (await intro.locator('[data-intro-next]').count()) {
      // Every slide shows its picture, loaded.
      await expect.poll(() => intro.locator('img:visible').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await intro.locator('[data-intro-next]').click();
    }
    await intro.locator('[data-intro-done]').click();
    await expect(intro).toHaveCount(0);
    await page.reload();
    await expect(page.locator('[data-welcome]')).toBeVisible();
    await expect(intro).toHaveCount(0);
    await page.locator('[data-welcome-example="decide"]').click();
    await send();
    let id: string | undefined;
    for (let n = 0; n < 150; n++) {
      const files = join(root, 'actor-files');
      id = existsSync(files) ? readdirSync(files).find(name => /^T\d+\.json$/.test(name))?.replace('.json', '') : undefined;
      if (id) break;
      if (existsSync(join(root, 'actor-errors.log'))) throw new Error(readFileSync(join(root, 'actor-errors.log'), 'utf8'));
      await delay(100);
    }
    assert.ok(id, 'The coordinator did not create an example Task');
    await expect.poll(async () => (await get(`/api/task/get?task=${id}`)).questions.some((question: { state: string }) => question.state === 'open'), { timeout: 25_000 }).toBe(true);
    await page.goto(`${url}?agent=1&project=${state.project}&task=${id}`);
    const question = page.locator('[data-question="1"]');
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: en ? /Whack/ : /もぐらたたき/ }).click();
    await send();
    await expect.poll(async () => {
      const snapshot = await get(`/api/task/get?task=${id}`);
      return { state: snapshot.task.state, question: snapshot.questions.some((question: { state: string }) => question.state === 'open') };
    }, { timeout: 30_000 }).toEqual({ state: 'waiting', question: false });
    // The result names the game that was picked, not the first one offered.
    assert.match((await get(`/api/task/get?task=${id}`)).task.values.conclusion, en ? /Whack-a-mole/ : /もぐらたたき/);
    await expect(page.locator('[data-task-done]:visible').first()).toBeEnabled();
    await page.locator('[data-task-done]:visible').first().click();
    await expect.poll(async () => (await get(`/api/task/get?task=${id}`)).task.state, { timeout: 15_000 }).toBe('done');

    // Words that are not an example get a reply and no Task: the stand-in never makes up work.
    const before = readdirSync(join(root, 'actor-files')).filter(name => /^T\d+\.json$/.test(name));
    const turns = (await get('/api/coordinator')).conversation.turns.length;
    await page.locator('[data-one-input]').click();
    await page.keyboard.insertText(en ? 'Hello' : 'こんにちは');
    await send();
    await expect.poll(async () => {
      const all = (await get('/api/coordinator')).conversation.turns;
      return all.length > turns && all.at(-1).status === 'succeeded';
    }, { timeout: 20_000 }).toBe(true);
    assert.deepEqual(readdirSync(join(root, 'actor-files')).filter(name => /^T\d+\.json$/.test(name)), before);

    // Explicitly exercise the preload boundary, rather than relying on the reporting interval not expiring.
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync(process.execPath, ['--import', join(root, 'network.mjs'), '--input-type=module', '-e',
      "const response = await fetch('https://alpacakit-telemetry.alpacakit.workers.dev/v1/report', {method:'POST',body:'synthetic'}); if(response.status!==204) process.exit(1);"],
      { env: { HOME: marker.home }, encoding: 'utf8', timeout: 5000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(existsSync(join(root, 'blocked-network.jsonl')), 'The preview transport was not exercised');
    console.log(`Journey passed (${language}, width ${width}): agents, skills, project, welcome, the introduction, an example's question, result and completion, a greeting without a Task; external sends: 0.`);
  } catch (error) {
    console.error('Journey error:', error);
    if (existsSync(join(root, 'actor-errors.log'))) console.error(readFileSync(join(root, 'actor-errors.log'), 'utf8'));
    console.error('Coordinator:', await (await fetch(new URL('/api/coordinator', url))).text());
    console.error('Preview backend:', readFileSync(join(root, 'home/fake-manager/backend.log'), 'utf8'));
    throw error;
  } finally { await browser.close(); }
}
