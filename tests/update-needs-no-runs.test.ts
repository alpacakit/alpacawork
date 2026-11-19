/** One rule says whether a version switches only once no Run is unfinished: the switch refuses on it, the screen says it first. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlSchemaManifest } from '@alpacawork/db';
import { switchNeedsNoRuns } from '../apps/backend/test-dist/release/switch.js';

test('a version needs every Run ended when its FORMAT differs from the running one or a live Run\'s, or its database differs from the one in use', t => {
  const current = mkdtempSync(join(tmpdir(), 'needs-no-runs-'));
  t.after(() => rmSync(current, { recursive: true, force: true }));
  const format = 'a'.repeat(64), control = controlSchemaManifest(), host = [{ name: '20260101000000_host', hash: 'c'.repeat(64) }];
  writeFileSync(join(current, 'FORMAT'), format);
  const state = { contractUsers: [], control, host };
  const facts = { format, schema: { control, host } };
  assert.equal(switchNeedsNoRuns(state, facts, current), null);
  assert.equal(switchNeedsNoRuns(state, { ...facts, format: 'b'.repeat(64) }, current), 'format');
  assert.equal(switchNeedsNoRuns({ ...state, contractUsers: [{ runId: 'R1', attemptId: 'a1', format: 'b'.repeat(64) }] }, facts, current), 'format');
  assert.equal(switchNeedsNoRuns(state, { format, schema: { control: { ...control, history: control.history.slice(0, -1) }, host } }, current), 'database');
  const newerHost = [...host, { name: '20260102000000_host', hash: 'd'.repeat(64) }];
  assert.equal(switchNeedsNoRuns(state, { format, schema: { control, host: newerHost } }, current), 'database');
  // No host database yet: the switch creates it at the release's history, so nothing waits for Runs.
  assert.equal(switchNeedsNoRuns({ ...state, host: null }, { format, schema: { control, host: newerHost } }, current), null);
});
