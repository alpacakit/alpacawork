import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('launch resolves frozen selections once and forwards only admitted environment names', async () => {
  const { launchArgv } = await import('@alpacawork/backend/test-dist/runs/launch-agent.js');
  const { agentEnvironment } = await import('@alpacawork/backend/test-dist/runs/env.js');
  const launch = { adapter: 'codex' as const, argv: ['agent', '--model', '{model}', '--session', '{session}', '-o', '{result}'],
    path: '/frozen/bin', values: { model: 'literal-{session}' }, env: ['EXTRA_KEY'] };
  assert.deepEqual(launchArgv({ launch, session: { provider: 'codex', id: 'session-1' } }, '/run'),
    ['agent', '--model', 'literal-{session}', '--session', 'session-1', '-o', '/run/result.tmp']);
  const env = agentEnvironment({ HOME: '/home/synthetic', EXTRA_KEY: 'current', SECRET: 'hidden' }, launch.path, undefined, launch.env);
  assert.equal(env.EXTRA_KEY, 'current');
  assert.equal(env.SECRET, undefined);
  assert.equal(env.PATH, '/frozen/bin');
  assert.throws(() => agentEnvironment({}, '/bin', undefined, ['ALPACAWORK_RUN']));
});

test('a synthetic child receives the frozen launch environment and produces an adapter receipt and reply', async t => {
  const { launchAgent } = await import('@alpacawork/backend/test-dist/runs/launch-agent.js');
  const { AGENT_RUNTIME_ADAPTERS } = await import('@alpacawork/backend/test-dist/agents/registry.js');
  const { writeFileSync } = await import('node:fs');
  const folder = mkdtempSync(join(tmpdir(), 'adapter-child-'));
  const key = 'ADAPTER_SYNTHETIC_ENV';
  const previous = process.env[key];
  let child: Awaited<ReturnType<typeof launchAgent>> | undefined;
  try {
    const script = join(folder, 'agent.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nprocess.stdin.once('data', data => { const input = JSON.parse(String(data)); console.log(JSON.stringify({type:'thread.started',thread_id:'s1'})); console.log(JSON.stringify({type:'input.taken',id:input.id})); writeFileSync(process.argv[2], process.env.ADAPTER_SYNTHETIC_ENV); console.log(JSON.stringify({type:'turn.completed'})); process.stdin.destroy(); });\n`);
    process.env[key] = 'synthetic-value';
    child = await launchAgent({ invocation: { mode: 'start', session: null, launch: { adapter: 'codex',
      argv: [process.execPath, script, '{result}'], path: process.env.PATH!, values: {}, env: [key] } },
      folder, root: folder, cwd: folder, release: null });
    const { processIdentity } = await import('@alpacawork/core');
    t.diagnostic(`child identity: ${JSON.stringify(processIdentity(child.child.pid!))}`);
    assert.equal(child.channel!.write('R1', 'synthetic', 'input-1'), true);
    const exit = await child.exited;
    const receipts = child.channel!.poll(folder, 's1').receipts;
    assert.equal(receipts[0]?.outcome, 'taken');
    const read = AGENT_RUNTIME_ADAPTERS.codex.read({ mode: 'start', session: null }, folder, exit);
    assert.deepEqual(read.outcome, { state: 'succeeded', session: 's1', result: 'synthetic-value' });
  } finally {
    if (child && child.child.exitCode === null && child.child.signalCode === null) { child.child.kill(); await child.exited; }
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});
