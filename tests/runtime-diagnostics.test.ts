/** Diagnose through the same display boundary, using only synthetic JSONL. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFolder, RUN_FILES } from '@alpacawork/contract/run';
import { readRunFailure } from '@alpacawork/backend/test-dist/runs/error-cause.js';

test('parent diagnosis excludes child events and non-object JSON records', t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-diagnostic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capacity = 'Selected model is at capacity. Please try a different model.';
  const thread = { type: 'thread.started', thread_id: 'synthetic-session' };
  const rootError = { type: 'error', message: capacity };
  const childError = { type: 'error', parent_tool_use_id: 'child', message: capacity };
  const check = (id: string, rows: unknown[]) => {
    const folder = runFolder(root, id); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, RUN_FILES.stdout), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return readRunFailure(root, { id, state: 'failed', reason: 'exit', resumes: null,
      session: { provider: 'codex', id: 'synthetic-session' }, launch: { adapter: 'codex' } });
  };
  assert.equal(check('R9', [thread, { type: 'error', session_id: 'foreign', message: capacity }]), undefined);
  assert.equal(check('R10', [thread, rootError, { type: 'turn.completed', session_id: 'foreign' }])?.cause, 'model_capacity');
  assert.equal(check('R11', [thread, rootError, { type: 'thread.started', thread_id: 'other', session_id: 'foreign' }])?.cause, 'model_capacity');
  assert.equal(check('R12', [thread, { type: 'error', thread_id: 'synthetic-session', session_id: 'foreign', message: capacity }]), undefined);
  assert.equal(check('R1', [thread, childError]), undefined);
  assert.equal(check('R2', [thread, rootError, 17]), undefined);
  assert.equal(check('R3', [thread, rootError])?.cause, 'model_capacity');
  assert.equal(check('R4', [thread, rootError, { type: 'turn.completed', parent_tool_use_id: 'child' }])?.cause, 'model_capacity');
  assert.equal(check('R5', [thread, rootError, { type: 'turn.completed' }]), undefined);
  assert.equal(check('R6', [thread, rootError, { type: 'error', thread_id: 'other', message: capacity }])?.cause, 'model_capacity');
  const childThread = { type: 'thread.started', parent_tool_use_id: 'child', thread_id: 'other' };
  assert.equal(check('R7', [thread, childThread, rootError])?.cause, 'model_capacity');
  assert.equal(check('R8', [childThread, rootError]), undefined);
});
