import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { AGENT_ADAPTERS, optionsBase } from '@alpacawork/contract/agent-adapters';
import { cliEntry, execute, setup } from './harness.ts';

test('remote CLI selects model and speed for the first Run from another cwd and HOME', async t => {
  const h = await setup(t, 1);
  assert.ok(h.task && h.placement);
  const fake = h.config.agents.fake;
  fake.params = { model: ['gpt-6-sol', 'gpt-6-astra'], effort: [], speed: ['default', 'fast'] };
  fake.options = { base: optionsBase('claude'),
    ...Object.fromEntries(Object.entries(AGENT_ADAPTERS.claude.options).map(([mode, options]) =>
      [mode, options.replace('[--model {model}]', '--model={model}') + ' --speed={speed}'])) as { start: string; resume: string },
  };
  writeFileSync(join(h.root, 'config.yaml'), stringify(h.config));

  const client = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-selected-client-')));
  t.after(() => rmSync(client, { recursive: true, force: true }));
  const instruction = join(client, 'instruction.md');
  writeFileSync(instruction, 'First instruction');
  const app = await h.server();
  const result = await execute(client, cliEntry, ['--server', app.url, 'task', 'request',
      '--task', h.task!.id, '--instruction-file', instruction,
      '--selected', JSON.stringify({ model: 'gpt-6-astra', speed: 'fast' }),
      '--expected-task-hash', h.task!.hash,
      '--expected-placement-revision', String(h.placement!.revision), '--op-id', randomUUID()],
    { HOME: client, XDG_CONFIG_HOME: join(client, '.config'), ALPACAWORK_SERVER: app.url }).done;
  assert.equal(result.code, 0, result.stderr);
  const runId = JSON.parse(result.stdout).outcome.request.runId as string;
  const run = await h.waitState(runId, 'succeeded');
  assert.deepEqual(run.launch.values, { model: 'gpt-6-astra', effort: null, speed: 'fast' });
  const invocations = readFileSync(join(h.root, 'fake-invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].pid, run.pids.agent);
  assert.ok(invocations[0].argv.includes('--model=gpt-6-astra'));
  assert.ok(invocations[0].argv.includes('--speed=fast'));
  assert.ok(run.pids.agent);
  assert.match(JSON.parse(readFileSync(join(h.root, 'processes', `${run.pids.agent}.json`), 'utf8')).prompt,
    /## Request\nFirst instruction/);
});
