/** Real development backend and bundled UI smoke check, always stopped by the owning test. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { chromium } from '@playwright/test';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from './fixture.ts';
import { until } from '../../tests/acceptance/processes.ts';

test('development server reads small and perf API, history pagination and real UI', { timeout: 90000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'dev-fixture-server-'));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const profile of ['small', 'perf'] as const) {
      const original = createOriginal({ ...profiles[profile], seed: 'server-test' }, join(sandbox, 'cache'));
      const copy = copyWorkspace(original.root, join(sandbox, profile));
      try {
        const app = await startServer(copy.root, 0);
        try {
          assert.throws(() => removeWorkspace(copy.root), /writer/);
          const live = await until(async () => {
            const response = await fetch(new URL('/api/workspace/live', app.url));
            if (!response.ok) return false;
            const data = await response.json();
            return data.errors?.length === 0 ? data : false;
          }, `${profile}: valid live index`);
          assert.deepEqual(live.errors, []);
          const response = await fetch(new URL('/api/task/view?task=T2', app.url));
          assert.equal(response.status, 200);
          const view = await response.json();
          assert.equal(view.task.id, 'T2');
          const history = await fetch(new URL('/api/task/history?task=T2&limit=20', app.url));
          assert.equal(history.status, 200);
          const page = await history.json();
          assert.ok(JSON.stringify(page).includes('Synthetic'));
          if (profile === 'perf') assert.ok(page.nextBefore, 'Dense history has another page');
          const tab = await browser.newPage();
          try {
            const errors: string[] = []; tab.on('pageerror', error => errors.push(error.message));
            await tab.goto(app.url);
            await tab.getByText('Synthetic development project', { exact: true }).first().waitFor({ timeout: 30000 });
            assert.deepEqual(errors, []);
          } finally { await tab.close(); }
        } finally { await app.close(); }
      } finally { removeWorkspace(copy.root); removeWorkspace(original.root); }
    }
  } finally { await browser.close(); rmSync(sandbox, { recursive: true, force: true }); }
});
