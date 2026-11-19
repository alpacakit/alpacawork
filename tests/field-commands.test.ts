/** field set on a synthetic workspace: adding only adds, changing only changes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fieldRuntime from '@alpacawork/backend/test-dist/control/field-commands.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
const { setField, listFields } = fieldRuntime as typeof import('../apps/backend/src/control/field-commands.js');

test('field set --create refuses an ID the workspace has, leaving the shared definition as it was', t => {
  const root = mkdtempSync(join(tmpdir(), 'aw-field-create-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeControlFixture(root);
  const at = '2026-11-08T00:00:00Z';
  assert.throws(() => setField(root, { field: 'goal', title: 'Risk', type: 'text', create: true }, at),
    (error: { reason?: { kind: string } }) => error.reason?.kind === 'field_exists');
  assert.equal(listFields(root).fields.find(field => field.id === 'goal')?.title, 'Goal');
  assert.equal(setField(root, { field: 'risk', title: 'Risk', type: 'text', create: true }, at).field.title, 'Risk');
});
