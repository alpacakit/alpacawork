/** Ordinary file readers must reject special files without waiting for another process. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopGroup } from './helpers/process-groups.ts';

const probe = `
  import assert from 'node:assert/strict';
  import { spawnSync } from 'node:child_process';
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  import { once } from 'node:events';
  import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
  import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
  import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
  import { taskFiles, openTaskFile } from '@alpacawork/backend/test-dist/control/task-files.js';
  import { readControlTree } from ${JSON.stringify(new URL('./helpers/control-tree.ts', import.meta.url).href)};
  import { captureAnswerFiles } from '@alpacawork/backend/test-dist/coordinator/answer-files.js';
  import { createPersonSettings } from '@alpacawork/backend/test-dist/receiver/person-state.js';
  const [root, reader] = process.argv.slice(1);
  const phase = name => process.stderr.write(JSON.stringify({reader, phase: name, at: Date.now()}) + '\\n');
  phase('imports-ready');
  await initializeWorkspace(root);
  phase('workspace-ready');
  const task = (await new ControlTaskCommands(root, {kind: 'human'}).create({parentId: 'P1',
    userRequested: null, tasks: [{title: 'Synthetic file reader'}]})).tasks[0];
  phase('task-ready');
  const folder = join(root, 'tasks', task.id);
  mkdirSync(folder, {recursive: true});
  writeFileSync(join(folder, 'good.txt'), 'ordinary bytes');
  const pipe = reader === 'answer' ? join(dirname(root), 'outside.txt') :
    reader === 'person' ? join(root, '.alpacawork', 'personal-settings.json') : join(folder, 'pipe.txt');
  const made = spawnSync('mkfifo', [pipe], {encoding: 'utf8', timeout: 2000});
  assert.equal(made.status, 0, made.stderr);
  const writer = new FileWriter(root);
  try {
    phase('fixture-ready');
    const permitted = once(process, 'message');
    process.send('ready');
    const [command] = await permitted;
    assert.equal(command, 'read');
    const started = performance.now();
    phase('read-start');
    if (reader === 'storage') assert.throws(() => writer.readAt(folder, 'pipe.txt'),
      {code: 'invalid_input', reason: {kind: 'expected_regular_file'}});
    else if (reader === 'video') await assert.rejects(openTaskFile(root, task.id, 'pipe.txt'),
      {code: 'invalid_input', reason: {kind: 'expected_regular_file'}});
    else if (reader === 'listing') assert.deepEqual(taskFiles(writer, ['tasks/' + task.id])
      .get('tasks/' + task.id).map(file => file.name), ['good.txt']);
    else if (reader === 'tree') assert.ok(await readControlTree(root));
    else if (reader === 'answer') assert.deepEqual(captureAnswerFiles(root, 'synthetic', 'synthetic',
      '[pipe](' + pipe + ')').map(file => file.state), ['unavailable']);
    else if (reader === 'person') await assert.rejects(createPersonSettings(root).get(), {code: 'unavailable'});
    else throw new Error('Unknown reader');
    phase('read-done');
    assert.ok(performance.now() - started <= 5000, 'reader exceeded its 5-second budget');
    process.send('read-done');
  } finally { writer.close(); }
  phase('closed');
  process.disconnect();
`;

for (const reader of ['storage', 'video', 'listing', 'tree', 'answer', 'person']) {
  test(`ordinary ${reader} reads do not block on a named pipe`, async t => {
    const area = mkdtempSync(join(tmpdir(), 'plain-reader-'));
    t.after(() => rmSync(area, { recursive: true, force: true }));
    const child = spawn(process.execPath, ['--input-type=module', '-e', probe, join(area, 'data'), reader],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '', stage = 'preparation', deadline = 0, active = true;
    let timer: ReturnType<typeof setTimeout>;
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const arm = (name: string, milliseconds: number) => {
          clearTimeout(timer);
          stage = name;
          deadline = performance.now() + milliseconds;
          timer = setTimeout(() => reject(new Error(`${reader}: ${stage} exceeded ${milliseconds}ms`)), milliseconds);
        };
        // Arm in the parent before allowing synchronous IO in the child. A child-local
        // timer cannot interrupt a blocked openSync. Imports/setup and close stay bounded.
        arm('preparation', 10_000);
        child.once('error', reject);
        child.on('message', message => {
          if (!active) return;
          try {
            assert.ok(performance.now() <= deadline, `${reader}: ${stage} deadline elapsed`);
            if (message === 'ready' && stage === 'preparation') {
              arm('read', 5000);
              child.send('read', error => { if (error) reject(error); });
            } else if (message === 'read-done' && stage === 'read') arm('close', 5000);
            else throw new Error(`${reader}: unexpected ${String(message)} during ${stage}`);
          } catch (error) { reject(error); }
        });
        child.once('close', (code, signal) => {
          try {
            assert.ok(performance.now() <= deadline, `${reader}: ${stage} deadline elapsed`);
            assert.equal(code, 0, `child exit ${code}, signal ${signal}\n${stderr}`);
            assert.equal(stage, 'close', `child exited before read-done\n${stderr}`);
            resolve();
          } catch (error) { reject(error); }
        });
      });
    } finally {
      active = false;
      clearTimeout(timer!);
      t.diagnostic(JSON.stringify({ reader, stage, pid: child.pid }) + '\n' + stderr.trim());
      // Also reap a mkfifo child if setup timed out. Reuse the fixture group's policy.
      if (child.pid) await stopGroup(child.pid);
      let closeTimer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          closeTimer = setTimeout(() => reject(new Error(`${reader}: child stdio did not close`)), 5000);
        })]);
      } finally { clearTimeout(closeTimer!); }
    }
  });
}
