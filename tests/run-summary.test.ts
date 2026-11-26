import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { TallyParser } from '@alpacawork/backend/test-dist/agents/adapters/tally.js';
import { joinDeliverables } from '@alpacawork/backend/test-dist/analysis/deliverables.js';
import { OutputActivityReader } from '@alpacawork/backend/test-dist/runs/activity.js';
import { RunStepIndex } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { isTestCommand } from '@alpacawork/backend/test-dist/runs/shell-evidence.js';
import { memberBasis, stepRepeats, stepTotals, testObservations } from '@alpacawork/backend/test-dist/runs/step-evidence.js';

test('test commands are recognized in command position only', () => {
  for (const script of ['pnpm test:quick', 'pnpm -w test', 'pnpm --workspace-root test', 'npm -w web test', 'npm --prefix web run test:unit', 'cd /project && npx vitest run',
    'pytest -q', 'pnpm vitest run', 'timeout 600 pnpm test', 'env CI=1 timeout -s TERM 60s pnpm --filter x test', 'yarn run test', 'pnpm exec playwright test', 'go test ./...', 'cargo test', '/bin/bash -lc "node --test unit.js"'])
    assert.equal(isTestCommand(script), true, script);
  for (const script of ['echo "pytest"', 'node app.js -- --test', 'test -f a', 'git diff test', 'playwright install',
    'cat <<\'END\'\npnpm test\nEND', 'pnpm run build # npm test'])
    assert.equal(isTestCommand(script), false, script);
});

test('Claude and Codex step evidence gives one tally and the tests read from it', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'summary-fixture-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'proof.md'), pr = 'https://github.com/fictional/catalog/pull/3';
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q');
  writeFileSync(path, 'proof');
  git('add', 'proof.md');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');

  const use = (id: string, name: string, input: object) => ({ type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name, input }] } });
  const reply = (id: string, content: string, is_error = false) => ({ type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  const command = (id: string, script: string, aggregatedOutput?: string, exitCode = 0) =>
    ({ type: aggregatedOutput === undefined ? 'item.started' : 'item.completed', item:
      { type: 'command_execution', id, command: script, cwd, aggregatedOutput, exitCode } });
  const compound = 'git commit -m proof && git push -u origin fixture && gh pr create --fill';
  const created = `[fixture ${sha.slice(0, 9)}] proof\n${pr}`;
  const merge = 'gh pr merge 3 --squash';
  const merged = 'Squashed and merged pull request fictional/catalog#3 (Proof)';
  for (const provider of ['claude', 'codex'] as const) {
    const rows: unknown[] = provider === 'claude' ? [
      use('test', 'Bash', { command: `cd ${cwd} && npm test` }), reply('test', 'ok'),
      use('file', 'Write', { file_path: path, content: 'proof' }), reply('file', 'saved'),
      use('pr', 'Bash', { command: compound }), reply('pr', created),
      use('merge', 'Bash', { command: merge }), reply('merge', merged),
    ] : [
      command('test', 'npm test'), command('test', 'npm test', 'failed', 1),
      { type: 'item.completed', item: { type: 'file_change', id: 'file', status: 'completed', changes: [{ path, kind: 'add' }] } },
      command('pr', compound), command('pr', compound, created),
      command('merge', merge), command('merge', merge, merged),
    ];
    for (let n = 0; n < 201; n++) {
      const id = 'edit-' + n;
      if (provider === 'claude') rows.push(use(id, 'Edit', { file_path: path }), reply(id, 'saved'));
      else rows.push({ type: 'item.completed', item: { type: 'file_change', id, status: 'completed', changes: [{ path, kind: 'update' }] } });
    }
    writeFileSync(join(cwd, 'stdout.log'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const index = new RunStepIndex(cwd, AGENT_RUNTIME_ADAPTERS[provider], cwd);
    const tally = new TallyParser(provider, provider, null);
    if (provider === 'claude') {
      // The work tree snapshot is a separate observation from the provider's eventual test result.
      new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude, undefined, undefined, undefined, cwd).poll(cwd);
    } else {
      rmSync(join(cwd, 'steps.jsonl'));
      writeFileSync(path, 'edited working copy');
      new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.codex, undefined, undefined, undefined, cwd).poll(cwd);
    }
    rows.forEach(row => tally.observe(row));
    await index.update('done');
    const { outputs, produced, truncated } = stepTotals(index.observations());
    const basis = memberBasis('Result\n\nBased on: 改善点.md; [調査結果](notes/report.md); R2');
    assert.equal(truncated, false);
    const summary = tally.finish('complete', { outputs, produced, basis });
    assert.equal(summary.v, 3);
    assert.equal(summary.outputs.largest[0]?.step, 2);
    assert.deepEqual(summary.basis, ['改善点.md', 'notes/report.md', 'R2']);
    assert.deepEqual(summary.produced.files, [{ step: 204, path }]);
    assert.deepEqual(summary.produced.commits, [{ step: 2, sha: sha.slice(0, 9), branch: 'fixture' }]);
    assert.deepEqual(summary.produced.prs, [{ step: 2, url: pr, action: 'created' }, { step: 3, url: pr, action: 'merged' }]);
    const observed = testObservations(index.observations()).map(item => item.test);
    assert.deepEqual(observed.map(item => [item.step, item.state, item.commitSource, item.commit, item.dirty, !!item.diffDigest, item.dirSource]),
      [[0, provider === 'claude' ? 'done' : 'failed', 'observed', sha, provider === 'codex', provider === 'codex', provider === 'codex' ? 'tool' : 'command']]);
  }
});

test('equal normalized shell inputs can still have different exact digests', async t => {
  const path = mkdtempSync(join(tmpdir(), 'summary-repeats-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const input = (id: string, command: string) => ({ type: 'assistant', parent_tool_use_id: null, message: {
    content: [{ type: 'tool_use', name: 'Bash', id, input: { command, description: `Read file (${id})`, timeout: id === 'a' ? 1000 : 2000 } }],
  } });
  const rows = [input('a', 'cat /fictional/a\nprintf hi'), input('b', 'cat /fictional/b\nprintf hi'), input('c', 'cat /fictional/a\nprintf hi')];
  writeFileSync(join(path, 'stdout.log'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const adapter = AGENT_RUNTIME_ADAPTERS.claude;
  new OutputActivityReader(adapter).poll(path);
  const index = new RunStepIndex(path, adapter, path);
  await index.update('done');
  const repeats = stepRepeats(index.observations());
  assert.deepEqual(repeats.exact.map(group => group.steps), [[0, 2]]);
  assert.deepEqual(index.range(0, 3).steps.map(step => step.fingerprint), Array(3).fill(index.range(0, 1).steps[0]!.fingerprint));
  assert.deepEqual(repeats.approximate.map(group => group.steps), [[0, 1, 2]]);
  assert.equal(repeats.exact[0]?.sameOutput, false);
});

test('a Task links a file and PR to the Run that produced them in its subtree', () => {
  const base = '/fictional/workspace', pr = 'https://github.com/fictional/catalog/pull/3';
  const tasks = [
    { id: 'T1', parent: null, title: 'Catalog', created: 0, log: [] },
    { id: 'T2', parent: 'T1', title: 'Proof', created: 0, log: [] },
  ];
  const summary = { state: 'complete' as const, basis: [], tests: [], outputs: { chars: 0, largest: [] },
    produced: { commits: [], files: [{ step: 1, path: `${base}/tasks/T1/proof.md` }], prs: [{ step: 2, url: pr, action: 'created' as const }] } };
  const runs = [{ id: 'R1', task: 'T2', summary }] as Parameters<typeof joinDeliverables>[3];
  const links = joinDeliverables(base, [
    { task: 'T1', field: 'artifact', entry: '[Proof](proof.md)', ref: 'proof.md' },
    { task: 'T1', field: 'pr', entry: pr, ref: pr },
  ], tasks, runs);
  assert.deepEqual(links.map(link => [link.match, link.runs]), [['file', ['R1']], ['pr', ['R1']]]);
});
