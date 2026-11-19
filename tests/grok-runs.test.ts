/** Shipped profile -> manager -> actual bridge -> fake provider -> committed Run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { checkAgentsText } from '@alpacawork/contract';
import { launchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';
import { cleanupGroups } from './helpers/process-groups.ts';
import { alive, setup } from './runs-runtime.fixture.ts';

const profilesText = readFileSync(join(import.meta.dirname, 'fixtures/grok.yaml'), 'utf8');
const profiles = parse(profilesText).agents;
test('The Grok profile example passes the production config validator', () => {
  assert.deepEqual(checkAgentsText(profilesText).issues, []);
});

test('Grok starts and resumes through the Run manager and closes both Runs', async t => {
  const provider = 'grok';
  const area = mkdtempSync(join(tmpdir(), `alpacawork-${provider}-runs-`));
  t.after(async () => {
    try { await cleanupGroups(area); }
    finally { rmSync(area, { recursive: true, force: true }); }
  });
  const binary = join(area, provider);
  const fakeUrl = new URL('./fixtures/fake-grok.mjs', import.meta.url).href;
  writeFileSync(binary, `#!${process.execPath}\n` +
    `import { appendFileSync } from 'node:fs';\n` +
    `appendFileSync(${JSON.stringify(join(area, 'receipts'))}, JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv})+'\\n');\n` +
    `setTimeout(()=>process.exit(124),15000).unref();\n` +
    `process.env.FAKE_GROK_LOG=${JSON.stringify(join(area, 'prompts'))};\n` +
    `await import(${JSON.stringify(fakeUrl)});\n`);
  chmodSync(binary, 0o755);
  const entry = join(import.meta.dirname, '../apps/agent-cli/dist/cli.js');
  const command = join(area, 'alpacawork-agent');
  writeFileSync(command, `#!${process.execPath}\nsetTimeout(()=>process.exit(124),15000).unref();\nawait import(${JSON.stringify(new URL(`file://${entry}`).href)});\n`);
  chmodSync(command, 0o755);
  const h = await setup(t);
  writeFileSync(join(h.root, 'config.yaml'), stringify({ limits: h.config.limits, agents: profiles }, { aliasDuplicateObjects: false }));
  // setup's default executable is a generic fake agent. Admit the actual bridge
  // with a PATH containing ONLY this test's binaries, through the production codec.
  const start = launchSnapshot({ ...h.config, agents: profiles }, provider, 'start', area);
  assert.equal(start.ok, true); if (!start.ok) throw new Error(start.code);
  const first = h.create(provider, {}, { launch: start.launch });
  await h.tick();
  const ended = await h.waitState(first, 'succeeded');
  assert.ok(ended.session?.id);
  assert.equal(h.store.getText(first.id)?.result, 'answer {}');
  const resume = launchSnapshot({ ...h.config, agents: profiles }, provider, 'resume', area, {}, ended.launch);
  assert.equal(resume.ok, true); if (!resume.ok) throw new Error(resume.code);
  const second = h.create(provider, {}, { resumes: first.id, session: ended.session, launch: resume.launch });
  await h.tick();
  const resumed = await h.waitState(second, 'succeeded');
  assert.equal(resumed.session?.id, ended.session?.id);
  assert.equal(h.store.getText(second.id)?.result, 'answer {}');
  await h.waitExchangeCleanup(first);
  await h.waitExchangeCleanup(second);
  const receipts = readFileSync(join(area, 'receipts'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) {
    assert.equal(receipt.argv[0], process.execPath);
    assert.equal(receipt.argv[1], binary);
    assert.equal(alive(receipt.pid), false);
    assert.equal(alive(receipt.ppid), false);
  }
  t.diagnostic(JSON.stringify({ provider, area, root: h.root, receipts,
    runs: [first, second].map(run => {
      const saved = h.store.runtimeGet(run.id)!;
      return { id: saved.id, state: saved.state, pids: saved.pids, launch: saved.launch, session: saved.session,
        result: h.store.getText(run.id)?.result };
    }) }));
  const calls = readFileSync(join(area, 'prompts'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].session, calls[1].session);
  assert.ok(calls[1].args.includes('--resume'));
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'grok-4.7');
    assert.equal(call.args[call.args.indexOf('--reasoning-effort') + 1], 'high');
  }
});
