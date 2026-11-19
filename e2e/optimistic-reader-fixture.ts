import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import type { Page, TestInfo } from '@playwright/test';
import type { Runtime } from './server.ts';
import { holdCoordinator } from './last-answer-evidence.ts';
import { fakeCoordinatorArgv } from './coordinator-fixture.ts';

/** The delayed review is a direct report; only the following answer launches an AI. */
export function holdSubmittedAnswer(root: string) {
  const release = holdCoordinator(root, fakeCoordinatorArgv);
  const gate = join(root, '.last-answer-hold'), entered = join(root, '.answer-ai-held');
  writeFileSync(join(root, 'last-answer-gate.mjs'), `import {existsSync,writeFileSync} from 'node:fs'; import {setTimeout} from 'node:timers/promises'; writeFileSync(${JSON.stringify(entered)},'held'); const end=Date.now()+60000; while(existsSync(${JSON.stringify(gate)})&&Date.now()<end) await setTimeout(20);`);
  return { release, entered: () => existsSync(entered) && existsSync(gate) };
}

/** Native touch time describes one moving finger independently of CDP round-trip scheduling.
 * Use with fixedTime:false: Playwright's installed clock would replace PointerEvent.timeStamp.
 */
export async function swipeSubmittedAnswer(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  try {
    const at = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
    for (let step = 0; step <= 4; step++) {
      await session.send('Input.dispatchTouchEvent', {
        type: step === 0 ? 'touchStart' : step === 4 ? 'touchEnd' : 'touchMove', timestamp: at + step * 0.016,
        touchPoints: step === 4 ? [] : [{ x: from.x + (to.x - from.x) * step / 3,
          y: from.y + (to.y - from.y) * step / 3 }],
      });
    }
  } finally { await session.detach(); }
}

/** Optional raw evidence, collected before the isolated serve keeper removes its workspace. */
export async function captureOptimisticRuntime(runtime: Runtime, info: TestInfo) {
  if (!process.env.OPTIMISTIC_READER_RAW) return;
  const dir = info.outputPath('raw-runtime');
  mkdirSync(dir, { recursive: true });
  const observation: any = { begin: new Date().toISOString(), ...runtime, atomic: false, api: [] };
  try {
    const path = controlDatabasePath(runtime.root);
    const db = new DatabaseSync(path, { readOnly: true });
    try { await backup(db, join(dir, 'backup.sqlite')); } finally { db.close(); }
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) cpSync(path + suffix, join(dir, 'raw.sqlite' + suffix));
    cpSync(join(runtime.root, 'config.yaml'), join(dir, 'config.yaml'));
    cpSync(join(runtime.root, '.alpacawork/runs'), join(dir, 'runs'), { recursive: true });
    for (const api of ['host/status', 'workspace/live', 'coordinator']) {
      const response = await fetch(runtime.origin + '/api/' + api);
      observation.api.push({ at: new Date().toISOString(), api, status: response.status, body: await response.json() });
    }
  } finally {
    observation.end = new Date().toISOString();
    writeFileSync(join(dir, 'capture.json'), JSON.stringify(observation, null, 2));
  }
}

/** Observe the real pointer stream without changing its timestamps or the reader's behavior. */
export async function observeOptimisticInput(page: Page) {
  if (!process.env.OPTIMISTIC_READER_RAW) return;
  await page.addInitScript(() => {
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      document.addEventListener(type, event => {
        const e = event as PointerEvent;
        console.debug('optimistic-pointer', JSON.stringify({ type, at: e.timeStamp, x: e.clientX, y: e.clientY, trusted: e.isTrusted, pointerType: e.pointerType,
          stamp: document.querySelector('[data-swipe-stamp]')?.getAttribute('data-swipe'),
          carried: document.querySelector('aside[data-reader-mode]')?.hasAttribute('data-carried') }));
      }, true);
  });
}
