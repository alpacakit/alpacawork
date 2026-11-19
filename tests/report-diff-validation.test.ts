import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { profiles, createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { validateReportMedia } from '@alpacawork/backend/test-dist/control/report-media.js';
import { comment } from '@alpacawork/backend/test-dist/control/task-questions.js';
import { withControlWrite } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { currentTaskHash, currentTaskLog } from './helpers/control-fixture.ts';

test('the report writer accepts UTF-8 diff/patch and refuses missing, linked, invalid UTF-8 and oversized embeds before recording', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'diff-validation-'));
  const original = createOriginal({ ...profiles.small, seed: 'diff-validation' }, join(temp, 'cache'));
  const root = join(temp, 'workspace'); copyWorkspace(original.root, root);
  t.after(() => {
    try { unlinkSync(join(root, 'tasks', task.id, 'diffs', 'linked.diff')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    removeWorkspace(root); removeWorkspace(original.root); rmSync(temp, { recursive: true, force: true });
  });
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: false,
    tasks: [{ title: 'Diff report fixture' }] })).tasks[0]!;
  const folder = join(root, 'tasks', task.id); mkdirSync(join(folder, 'diffs'), { recursive: true });
  writeFileSync(join(folder, 'diffs', 'valid.diff'), '--- a/文書.md\n+++ b/文書.md\n@@ -1 +1 @@\n-前\n+後\n');
  writeFileSync(join(folder, 'diffs', 'bad.diff'), Buffer.from([0xc3, 0x28]));
  writeFileSync(join(folder, 'diffs', 'incomplete.patch'), Buffer.from([0xe3, 0x81]));
  writeFileSync(join(folder, 'diffs', 'large.diff'), '');
  truncateSync(join(folder, 'diffs', 'large.diff'), 257 * 1024 * 1024);
  copyFileSync('e2e/fixture/wide-report.png', join(folder, 'valid.png'));
  copyFileSync('e2e/fixture/clip.webm', join(folder, 'valid.webm'));
  writeFileSync(join(folder, 'invalid.png'), 'not an image');
  writeFileSync(join(folder, 'invalid.webm'), 'not a video');
  symlinkSync(join(folder, 'diffs', 'valid.diff'), join(folder, 'diffs', 'linked.diff'));
  const before = currentTaskLog(root, task.id).length;
  for (const path of ['diffs/missing.diff', 'diffs/bad.diff', 'diffs/incomplete.patch', 'diffs/linked.diff', 'diffs/large.diff', 'invalid.png', 'invalid.webm']) {
    assert.throws(() => withControlWrite(root, tx => comment(tx, { actor: { kind: 'human' }, runId: null,
      taskId: task.id, opId: randomUUID(), expectedTaskHash: currentTaskHash(root, task.id), title: 'Review',
      description: `![review evidence](${path})` })), error => {
      assert.equal((error as { code: string }).code, 'invalid_input');
      assert.equal((error as { issues: { code: string }[] }).issues[0]?.code, 'invalid_media'); return true;
    }, path);
    assert.equal(currentTaskLog(root, task.id).length, before, path);
  }
  assert.doesNotThrow(() => validateReportMedia(root, `tasks/${task.id}`, '![diff](diffs/valid.diff)'));
  assert.doesNotThrow(() => validateReportMedia(root, `tasks/${task.id}`, '![review image](valid.png)\n![review video](valid.webm)'));
});
