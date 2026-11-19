/** The real Service Worker and browser restart, pull at the offline boundary, parked words in a cut, finished rows over a reload. pnpm test:e2e:offline after a build, and a stage of test:all. */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import standard from './playwright.base.ts';
const evidence = resolve(process.env.OFFLINE_SCOPE_EVIDENCE ?? `.local/test-runs/offline-scope-${Date.now()}-${randomUUID()}`);
export default defineConfig(standard, {
  testDir: '.', testMatch: ['offline-scope.check.ts', 'offline-ux.check.ts', 'offline-receipt-parked.check.ts', 'read-repair-diagnostics.check.ts'], globalSetup: undefined,
  outputDir: resolve(evidence, 'cases'), fullyParallel: true, workers: 4, retries: 0,
  // Each case owns its runtime and persistent profile. Keep every case's 120 s budget and the existing overall backstop.
  globalTimeout: 20 * 60_000,
  reporter: [['list'], ['json', { outputFile: resolve(evidence, 'result.json') }]],
  use: { ...standard.use, serviceWorkers: 'allow', trace: 'off', video: 'off', screenshot: 'off' },
});
