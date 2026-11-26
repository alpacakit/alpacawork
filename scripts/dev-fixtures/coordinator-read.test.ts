/** The real browser reads a long synthetic conversation a page at a time. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { stringify } from 'yaml';
import { RunStore } from '@alpacawork/runs';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { fixtureAgentSetting } from '../../tests/helpers/agent-stub.ts';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from './fixture.ts';

for (const width of [1440, 390]) test(`older coordinator turns load by page and keep their order (${width}px)`, { timeout: 30_000 }, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'coordinator-history-browser-'));
  const original = createOriginal({ ...profiles.small, seed: 'coordinator-history-browser' }, join(sandbox, 'cache'));
  const copy = copyWorkspace(original.root, join(sandbox, 'workspace'));
  const root = copy.root;
  try {
    writeFileSync(join(root, 'config.yaml'), stringify({
      agents: { synthetic: { ...fixtureAgentSetting('claude'), params: {}, command: '/usr/bin/false' } },
    }));
    const conversation = new CoordinatorConversation(root);
    const conversationId = conversation.read().id;
    const ids = Array.from({ length: 133 }, () => crypto.randomUUID());
    await conversation.seedSeen();
    conversation.ask({ conversationId, id: ids[0]!, text: 'Synthetic question 1', attachments: [] });
    const store = new RunStore(root, { busyTimeoutMs: 1000 });
    try {
      const seed = store.coordinatorHead(conversationId)!;
      const { agent, launch, cwd, message } = seed;
      const created = Date.parse(seed.created_at);
      store.write(tx => {
        for (const [index, id] of ids.entries()) {
          const at = new Date(created + index * 1000).toISOString();
          const ended = new Date(created + index * 1000 + 500).toISOString();
          if (index > 0) tx.insertConversationRequest({
            id, conversationId, headRunId: null, mode: 'new', body: `Synthetic question ${index + 1}`,
            submittedAt: at, deliveryState: 'queued',
          });
          const run = index === 0 ? seed : tx.createCoordinatorRun({
            conversationId, requestId: id, agent, launch, cwd, message, resumes: null, session: null,
          }, 'Synthetic prompt');
          tx.update({ ...run, state: 'running', started_at: at });
          tx.finish({ ...run, state: 'succeeded', started_at: at, ended_at: ended },
            { state: 'present', text: `Synthetic reply ${index + 1}. It stays in its own turn.` });
        }
      });
    } finally { store.close(); }
    const server = await startServer(root, 0);
    try {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        const pages: string[] = [];
        page.on('request', request => {
          const url = new URL(request.url());
          if (url.pathname === '/api/coordinator/turns') pages.push(url.searchParams.get('before')!);
        });
        await page.goto(server.url);
        await page.locator('[data-coordinator-expand]').first().click();
        const panel = page.locator('[data-coordinator-panel]');
        const rows = panel.locator('[data-coordinator-turn]');
        const older = panel.locator('[data-earlier-more] button');
        await expect(panel.locator('[data-earlier]')).toContainText('132 earlier messages');
        await expect(rows).toHaveCount(1);
        assert.deepEqual(pages, []);
        await panel.locator('[data-earlier] button').click();
        await expect(rows).toHaveCount(20);
        for (const total of [70, 120, 133]) {
          await older.click();
          await expect(rows).toHaveCount(total);
          const drawn = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-coordinator-message')));
          assert.deepEqual(drawn, ids.slice(-total));
        }
        assert.deepEqual(pages, [ids[113], ids[63], ids[13]]);
        await expect(older).toHaveCount(0);
      } finally { await browser.close(); }
    } finally { await server.close(); }
  } finally {
    removeWorkspace(root);
    removeWorkspace(original.root);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
