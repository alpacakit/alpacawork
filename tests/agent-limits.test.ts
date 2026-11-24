import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLimitsMonitor } from '@alpacawork/backend/test-dist/agents/limits.js';
import { claudeLimits } from '@alpacawork/backend/test-dist/agents/adapters/claude.js';
import { codexLimitWindows } from '../apps/agent-cli/test-dist/codex.js';
import { copilotLimitWindows, copilotUsage } from '../apps/agent-cli/test-dist/copilot.js';

const reset = '2026-11-29T15:00:00.000Z';

test('Claude: the week, the 5-hour session, each model\'s own week and the signed-in account, from the control responses alone', () => {
  const answer = { type: 'control_response', response: { subtype: 'success', request_id: 'limits', response: { rate_limits_available: true,
    rate_limits: { five_hour: null, seven_day: { utilization: 63, resets_at: reset }, seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 77, resets_at: reset }] } } } };
  const account = { type: 'control_response', response: { subtype: 'success', request_id: 'account', response: { account: { email: 'someone@example.com' } } } };
  const stdout = [JSON.stringify({ type: 'system', subtype: 'init' }), JSON.stringify(account), JSON.stringify(answer)].join('\n');
  assert.deepEqual(claudeLimits.read(stdout), { account: 'someone@example.com', windows: [
    { kind: 'weekly', minutes: 10_080, model: null, usedPercent: 63, resetsAt: reset },
    { kind: 'weekly', minutes: 10_080, model: 'Fable', usedPercent: 77, resetsAt: reset }] });
  // An API key has no plan limits to read, and an answer without the account names no one.
  assert.deepEqual(claudeLimits.read(JSON.stringify({ ...answer, response: { ...answer.response, response: { rate_limits_available: false } } })),
    { windows: [], account: null });
});

test('Codex: each window says its own length; a missing secondary is no window', () => {
  assert.deepEqual(codexLimitWindows({ rateLimits: { primary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1795704765 }, secondary: null } }),
    [{ kind: 'weekly', minutes: 10_080, model: null, usedPercent: 8, resetsAt: '2026-11-26T14:52:45.000Z' }]);
  assert.deepEqual(codexLimitWindows({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: null } } })[0]?.kind, 'session');
});

test('Copilot: the plan\'s limited monthly allowance; a reset that is not ahead is none; tokens exclude the cache', () => {
  const now = Date.parse('2026-11-24T00:00:00Z');
  const quota = (premium: number, chatReset: string) => ({ quotaSnapshots: {
    premium_interactions: { isUnlimitedEntitlement: false, entitlementRequests: premium, remainingPercentage: 70, resetDate: '2026-12-01T00:00:00Z' },
    chat: { isUnlimitedEntitlement: false, entitlementRequests: 200, remainingPercentage: 88.8, resetDate: chatReset },
    completions: { isUnlimitedEntitlement: false, entitlementRequests: 2000, remainingPercentage: 1, resetDate: chatReset } } });
  assert.deepEqual(copilotLimitWindows(quota(300, '2026-12-01T00:00:00Z'), now),
    [{ kind: 'monthly', minutes: null, model: null, usedPercent: 30, resetsAt: '2026-12-01T00:00:00.000Z' }]);
  assert.deepEqual(copilotLimitWindows(quota(0, '2026-11-23T00:00:00Z'), now),
    [{ kind: 'monthly', minutes: null, model: null, usedPercent: 11.2, resetsAt: null }]);
  assert.deepEqual(copilotUsage([{ inputTokens: 8682, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
    { inputTokens: 8725, cacheReadTokens: 7680, cacheWriteTokens: 0, outputTokens: 6 }]),
  { scope: 'run', counters: { input: 9727, cacheRead: 7680, cacheWrite: 0, output: 11 } });
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agent-limits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), calls = join(root, 'calls');
  mkdirSync(bin); writeFileSync(calls, '');
  // Claude answers its control request; the bridge prints its windows, or fails once `fail` exists.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(calls)}, 'claude\\n');
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'limits',
  response: { rate_limits_available: true, rate_limits: { seven_day: { utilization: 50, resets_at: ${JSON.stringify(reset)} } } } } })));\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}\n`, { mode: 0o700 });
  const bridge = join(root, 'bridge.mjs');
  writeFileSync(bridge, `import { appendFileSync, existsSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');
if (existsSync(${JSON.stringify(join(root, 'fail'))})) process.exit(2);
console.log(JSON.stringify({ windows: [{ kind: 'weekly', minutes: 10080, model: null, usedPercent: 9, resetsAt: null }], account: 'someone' }));\n`);
  let now = 0;
  const config = { agents: { grok: { enabled: true }, codex: { enabled: true }, claude: { enabled: true }, 'claude-chrome': { adapter: 'claude', enabled: true },
    off: { adapter: 'copilot', enabled: false } }, aiStack: [{ agent: 'claude' }] };
  const monitor = new AgentLimitsMonitor({ config: async () => config as never, now: () => now, freshMs: 1000,
    environment: { cwd: root, env: { PATH: bin, HOME: root }, bridge: [process.execPath, bridge] } });
  return { root, monitor, calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean), advance: (ms: number) => { now += ms; } };
}

test('one entry per kind of agent, the task stack\'s first, then the other enabled ones; each asked once while fresh', async t => {
  const f = fixture(t);
  const first = await f.monitor.read();
  assert.deepEqual(first.agents.map(agent => [agent.adapter, agent.state]), [['claude', 'ok'], ['grok', 'unsupported'], ['codex', 'ok']]);
  assert.equal(first.agents[0]!.windows[0]!.usedPercent, 50);
  assert.equal(first.agents.find(agent => agent.adapter === 'codex')!.account, 'someone');
  assert.match(f.calls().find(call => call.startsWith('codex')) ?? '', /^codex --command .*\/codex --limits$/);
  await f.monitor.read();
  assert.equal(f.calls().length, 2);
});

test('a failed read keeps the last windows and their time; an agent never read says it could not be', async t => {
  const f = fixture(t);
  const before = (await f.monitor.read()).agents.find(agent => agent.adapter === 'codex')!;
  writeFileSync(join(f.root, 'fail'), '');
  f.advance(2000);
  await f.monitor.read(); // Returns what it knows and asks again behind it.
  while (f.calls().filter(call => call.startsWith('codex')).length < 2) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 100)); // The failed answer is in.
  assert.deepEqual((await f.monitor.read()).agents.find(agent => agent.adapter === 'codex'), before);
  const fresh = fixture(t);
  appendFileSync(join(fresh.root, 'fail'), '');
  assert.deepEqual((await fresh.monitor.read()).agents.find(agent => agent.adapter === 'codex'),
    { adapter: 'codex', state: 'unavailable', windows: [], account: null, observedAt: null });
});
