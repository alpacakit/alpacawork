/** Real bundled screen, common synthetic workspace, controlled catalog/admission. No provider is started. */
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../../../scripts/dev-fixtures/fixture.ts';
import { cleanEnv } from '../../../tests/acceptance/processes.ts';
import { startServer } from '@alpacawork/backend/dist/receiver/server.js';

if (process.argv[2] === '--fixture-server') {
  const app = await startServer(process.argv[3]!, 0);
  const deadline = setTimeout(() => { void app.close().finally(() => process.exit(1)); }, 180000); deadline.unref();
  process.send!({ url: app.url });
  process.stdin.resume(); await once(process.stdin, 'end'); await app.close();
} else {
  const evidence = resolve(process.env.ALPACAWORK_UI_EVIDENCE ?? '/tmp/skills-send-ui'); mkdirSync(evidence, { recursive: true });
  const sandbox = mkdtempSync(join(tmpdir(), 'skills-send-screen-'));
  const original = createOriginal({ ...profiles.small, seed: 'skills-send' }, join(sandbox, 'cache'));
  const copy = copyWorkspace(original.root, join(sandbox, 'workspace'));
  const home = join(sandbox, 'home'); mkdirSync(home);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-server', copy.root], {
    env: cleanEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') }), stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const exit = once(child, 'exit'); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let diagnostics = ''; child.stderr!.on('data', data => { diagnostics += data; });
  try {
    const [message] = await Promise.race([once(child, 'message'), exit.then(() => { throw new Error(diagnostics); })]);
    const { url } = message as { url: string };
    browser = await chromium.launch();
    const checks: object[] = [];
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: 'ja-JP', serviceWorkers: 'block' });
      try {
        const packet = await (await fetch(new URL('/api/coordinator', url))).json();
        let conversation = packet.conversation, current = false, posts = 0;
        const fix5 = process.env.ALPACAWORK_UI_SCENARIOS === 'fix5';
        const consumption = fix5 || process.env.ALPACAWORK_UI_SCENARIOS === 'consumption';
        const bodies: any[] = []; let refuseNext = false, holdNext: Promise<void> | null = null;
        const command = 'npx --yes --package=alpacawork@0.3.0 alpacawork skills update --package-version 0.3.0';
        const response = () => ({ ...packet, revision: createHash('sha256').update(JSON.stringify(conversation)).digest('hex'), conversation });
        await page.route('**/api/coordinator', route => route.fulfill({ json: response() }));
        await page.route('**/api/coordinator/warm', route => route.fulfill({ json: response() }));
        await page.route('**/api/coordinator/skills?**', route => route.fulfill({ json: { status: 'ready', profile: 'fixture',
          skills: [{ name: 'alpacawork', invocation: '$', description: '合成スキル' }] } }));
        await page.route('**/api/coordinator/messages', async route => {
          posts++; const input = route.request().postDataJSON(); bodies.push(input);
          if (!consumption) expect(input.skills).toEqual(['alpacawork']);
          if (holdNext) { const held = holdNext; holdNext = null; await held; }
          if (refuseNext) { refuseNext = false; return route.fulfill({ status: 409, json: { error: { code: 'conflict', retry: 'reread', message: 'synthetic refusal' } } }); }
          if (!current) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'version mismatch', retry: 'reread',
            reason: { kind: 'managed_skills_version', skill: 'alpacawork', currentVersion: '0.2.0', expectedVersion: '0.3.0', command } } } });
          conversation = { ...conversation, turns: [...conversation.turns, { skills: input.skills, tasks: input.tasks, id: input.id, at: '2026-11-04T00:00:00Z', ask: input.text, attachments: [],
            status: 'succeeded', waiting: false, answer: '合成の受理結果', seen: false, answeredAt: '2026-11-04T00:00:01Z', error: null, result: { writes: [], refused: [] } }] };
          return route.fulfill({ json: response() });
        });
        await page.goto(`${url}?agent=1`);
        await page.locator('[data-coordinator-expand]').first().click();
        const field = page.locator('[data-one-input]');
        if (!await field.isVisible()) await page.locator('[data-coordinator-write]').click();
        await expect(field).toBeVisible();
        if (fix5) {
          current = true; const send = page.locator('[data-ask-send]');
          const append = async (text: string) => { await field.focus(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text); };
          const screenshot = async (name: string) => {
            const area = page.locator('[data-one-input-area]');
            await area.evaluate(element => {
              (element as HTMLElement).style.outline = '2px solid #d52222';
              const label = document.createElement('span'); label.dataset.fix5Annotation = '';
              label.textContent = '入力欄：未送信の文だけ';
              Object.assign(label.style, { position: 'fixed', left: `${element.getBoundingClientRect().x + 4}px`, top: `${element.getBoundingClientRect().y - 22}px`, background: 'white', color: '#b51c1c', fontSize: '12px', zIndex: '99999', pointerEvents: 'none' });
              document.body.append(label);
            });
            const box = await area.boundingBox();
            if (box) await page.screenshot({ path: join(evidence, `${name}-${width}.png`), clip: { x: Math.max(0, box.x - 3), y: Math.max(0, box.y - 70), width: Math.min(width - Math.max(0, box.x - 3), box.width + 6), height: Math.min(900 - Math.max(0, box.y - 70), box.height + 75) }, animations: 'disabled' });
            await area.evaluate(element => { (element as HTMLElement).style.outline = ''; document.querySelector('[data-fix5-annotation]')?.remove(); });
          };
          await append('はい'); await send.click(); await append('はい、あと確認してください。');
          await expect(field).toHaveText('はい、あと確認してください。', { timeout: 20000 });
          await screenshot('quote-next'); await send.click();
          await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(2); await expect(field).toHaveText('');
          expect(bodies.map(body => body.text)).toEqual(['はい', 'はい、あと確認してください。']);
          let release!: () => void; holdNext = new Promise<void>(resolve => { release = resolve; });
          await append('1'); await send.click(); await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(3);
          await append('1件だけ確認してください。'); await send.click(); expect(bodies).toHaveLength(3); release();
          await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(4); await expect(field).toHaveText('');
          expect(bodies.slice(2).map(body => body.text)).toEqual(['1', '1件だけ確認してください。']);
          // Task recipients are shared context; a refused skill-bearing head still owns only its actual body.
          await append('#T2'); await page.getByRole('listbox').getByRole('option', { name: /^T2\b/ }).click();
          await append(' /'); await page.getByRole('listbox').getByRole('option', { name: /alpacawork/ }).click();
          await append(' 先頭の依頼です。'); refuseNext = true; holdNext = new Promise<void>(resolve => { release = resolve; });
          await send.click(); await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(5);
          await append('後続の依頼です。'); await send.click(); expect(bodies).toHaveLength(5); release();
          await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(6);
          await expect(field).toContainText('先頭の依頼です。'); await expect(field).not.toContainText('後続の依頼です。');
          await expect(page.locator('[data-one-input-area] [data-label=skill]')).toHaveCount(1);
          await expect(page.locator('[data-coordinator-local=refused]')).toHaveCount(0);
          expect(bodies[5].text).toContain('後続の依頼です。'); expect(bodies[5].text).not.toContain('先頭の依頼です。');
          expect(bodies[5].tasks).toEqual(['T2']); await screenshot('refused-head-only');
          await send.click(); await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(7);
          expect(bodies[6].text).toContain('先頭の依頼です。'); expect(bodies[6].text).not.toContain('後続の依頼です。');
          await expect(field).not.toContainText('先頭の依頼です。'); await expect(send).toBeDisabled();
          await expect(page.locator('[data-coordinator-local=refused]')).toHaveCount(0);
          checks.push({ width, scenarios: ['quoted-short-append', 'short-next-queued', 'task-and-skill-refused-head-accepted-tail'],
            bodies: bodies.map(body => ({ id: body.id, text: body.text, tasks: body.tasks, skills: body.skills })), accepted: conversation.turns.length, refusedRows: 0 });
          continue;
        }
        if (consumption) {
          current = true; const send = page.locator('[data-ask-send]');
          const inputText = async (text: string) => { await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(text); };
          const screenshot = async (name: string) => {
            const box = await page.locator('[data-one-input-area]').boundingBox();
            if (box) await page.screenshot({ path: join(evidence, `${name}-${width}.png`), clip: { x: Math.max(0, box.x), y: Math.max(0, box.y - 70), width: Math.min(width - Math.max(0, box.x), box.width), height: Math.min(900 - Math.max(0, box.y - 70), box.height + 70) }, animations: 'disabled' });
          };
          // Write the next instruction during the real five-second undo window.
          await inputText('一つ目の依頼です。'); await send.click(); await inputText('二つ目も頼みます。');
          await expect(field).toHaveText('二つ目も頼みます。', { timeout: 20000 });
          await screenshot('accepted-next'); await send.click();
          await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(2);
          await expect(field).toHaveText('');
          expect(bodies.map(body => body.text)).toEqual(['一つ目の依頼です。', '二つ目も頼みます。']);
          // Press the next send while the first POST is still unresolved.
          let release!: () => void; holdNext = new Promise<void>(resolve => { release = resolve; });
          await inputText('三つ目の依頼です。'); await send.click();
          await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(3);
          await inputText('四つ目も頼みます。'); await send.click();
          expect(bodies).toHaveLength(3); release();
          await expect.poll(() => bodies.length, { timeout: 20000 }).toBe(4);
          await expect(field).toHaveText('');
          expect(bodies.slice(2).map(body => body.text)).toEqual(['三つ目の依頼です。', '四つ目も頼みます。']);
          // Refusal retains the complete original and new text with its skill, without a second refused row.
          await field.click(); await page.keyboard.insertText('/');
          await page.getByRole('listbox').getByRole('option', { name: /alpacawork/ }).click();
          await page.keyboard.insertText(' 拒否される依頼です。'); refuseNext = true; await send.click();
          await inputText('続きの文です。');
          await expect(page.locator('[data-toast]').filter({ hasText: '送れませんでした' })).toBeVisible({ timeout: 20000 });
          await expect(field).toContainText('拒否される依頼です。続きの文です。');
          await expect(page.locator('[data-one-input-area] [data-label=skill]')).toHaveCount(1);
          await expect(page.locator('[data-coordinator-local=refused]')).toHaveCount(0);
          expect(bodies).toHaveLength(5); await screenshot('refused-next');
          checks.push({ width, scenarios: ['append-during-grace', 'next-send-during-pending', 'refusal-after-append'], bodies: bodies.map(body => ({ id: body.id, text: body.text, skills: body.skills })), accepted: conversation.turns.length, refusedRows: 0 });
          continue;
        }
        await field.click(); await page.keyboard.insertText('/');
        await page.getByRole('listbox').getByRole('option', { name: /alpacawork/ }).click();
        await expect(page.locator('[data-one-input-area] [data-label=skill]')).toHaveCount(1);
        await page.keyboard.insertText(' 版をそろえてから、この文を送ります。');
        const send = page.locator('[data-ask-send]'); await send.click();
        const toast = page.locator('[data-toast]').filter({ hasText: command }); await expect(toast).toBeVisible({ timeout: 20000 });
        await expect(field).toContainText('版をそろえてから、この文を送ります。');
        await expect(page.locator('[data-one-input-area] [data-label=skill]')).toHaveCount(1);
        await page.screenshot({ path: join(evidence, `mismatch-${width}.png`), animations: 'disabled' });
        const bounds = await field.boundingBox(), alert = await toast.boundingBox();
        writeFileSync(join(evidence, `bounds-${width}.json`), JSON.stringify({ field: bounds, toast: alert }));
        expect(posts).toBe(1); current = true;
        // No update callback can POST. This is the person's next click.
        await send.click(); await expect(field).not.toContainText('版をそろえてから、この文を送ります。', { timeout: 20000 });
        expect(posts).toBe(2); checks.push({ width, posts, accepted: conversation.turns.length, command });
      } catch (error) {
        await page.screenshot({ path: join(evidence, `failure-${width}.png`), animations: 'disabled' }).catch(() => {});
        writeFileSync(join(evidence, `failure-${width}.txt`), String(error) + '\n' + await page.locator('body').innerText());
        throw error;
      } finally { await page.close(); }
    }
    writeFileSync(join(evidence, 'checks.json'), JSON.stringify(checks, null, 2));
  } catch (error) { writeFileSync(join(evidence, 'failure.txt'), String(error) + '\n' + diagnostics); throw error; }
  finally {
    await browser?.close(); child.stdin!.end();
    await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('fixture server did not close')); }, 15000); timer.unref(); })]);
    removeWorkspace(copy.root); removeWorkspace(original.root); rmSync(sandbox, { recursive: true, force: true });
  }
}
