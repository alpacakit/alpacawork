/**
 * Agent selection has one rule: explicit choice, conversation head, then the first enabled agent. A continued session
 * goes through the shared resolver with the conversation's values; nothing is silently replaced. No process starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { optionsBase } from '@alpacawork/contract/agent-adapters';
import { RunStore } from '@alpacawork/runs';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { defaultAgentSetting } from '@alpacawork/contract/agent-settings';
import { parseAgentsSettings, launchSnapshot, coordinatorLaunchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';
import { launchArgv } from '@alpacawork/backend/test-dist/runs/launch-agent.js';
import { createPersonSettings, languageLine } from '@alpacawork/backend/test-dist/receiver/person-state.js';

/** The refusal's kind; its other fields belong to the shared admission reason. */
const refused = (kind: string) => (error: any) => error?.reason?.kind === kind;
const claude = (extra: object = {}) => ({ adapter: 'claude', params: { model: ['synthetic-a', 'synthetic-b'], effort: [] }, ...extra });
function fixture(t: any) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-agent-selection-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initializeControlFixture(root);
  const config = (agents: object) => writeFileSync(join(root, 'config.yaml'), stringify({ agents }, { aliasDuplicateObjects: false }), { mode: 0o600 });
  const owner = new CoordinatorConversation(root);
  const conversation = { id: owner.read().id };
  const ask = (agent?: string, selected: Record<string, string | null> = {}) => owner.ask({ conversationId: conversation.id, id: randomUUID(),
    text: 'Synthetic message', attachments: [], selected, ...agent === undefined ? {} : { agent } });
  return { root, owner, conversation, config, ask };
}

test('each coordinator input snapshots the saved reply language at admission, leaving unset inputs unchanged', async t => {
  const f = fixture(t);
  f.config({ first: claude() });
  f.owner.warm(f.conversation.id);
  const settings = createPersonSettings(f.root), store = new RunStore(f.root, { busyTimeoutMs: 1000 });
  t.after(() => store.close());
  const prompt = (id: string) => store.getText(store.coordinatorRuns(f.conversation.id).find(run => run.requestId === id)!.id)!.prompt!;
  const send = () => {
    const input = { conversationId: f.conversation.id, id: randomUUID(), text: 'Synthetic message', attachments: [], selected: {} };
    f.owner.ask(input);
    return input;
  };
  const unset = send();
  assert.equal(prompt(unset.id).split('\n').slice(1).join('\n'), unset.text);
  const set = async (value: string | null) => settings.set('ai.language', value, (await settings.get()).revision);
  await set('ja-JP');
  const japanese = send(), original = prompt(japanese.id);
  assert.equal(original.split('\n').slice(1).join('\n'),
    languageLine('ja-JP') + 'Synthetic message');
  await set('en-US');
  assert.equal(prompt(send().id).split('\n')[1] + '\n', languageLine('en-US'));
  f.owner.ask(japanese);
  assert.equal(prompt(japanese.id), original, 'replaying an accepted input retains its admitted language');
  await set(null);
  assert.equal(prompt(send().id).split('\n').slice(1).join('\n'), unset.text);
});

test('every enabled agent can coordinate; explicit, inherited, absent and unknown names have distinct results', t => {
  const { owner, conversation, config, ask } = fixture(t);
  config({ first: claude(), second: claude() });
  assert.equal(ask().agent, 'first');
  assert.equal(ask('second').agent, 'second');
  assert.equal(ask().agent, 'second');
  assert.throws(() => ask('missing'), { code: 'invalid_input', reason: { kind: 'agent_not_configured', agent: 'missing' } });
  config({ first: claude() });
  assert.throws(() => ask(), { code: 'invalid_input', reason: { kind: 'agent_not_configured', agent: 'second' } });
  assert.equal(ask('first').agent, 'first', 'An explicit selection overrides a removed head agent');
  conversation.id = owner.clear(conversation.id).id;
  config({});
  assert.throws(() => ask(), { code: 'invalid_settings', reason: { kind: 'no_configured_agents' } });
});

test('the default is the first enabled agent; a disabled chosen or inherited agent is refused, never replaced', t => {
  const { owner, conversation, config, ask } = fixture(t);
  config({ first: claude({ enabled: false }), second: claude() });
  assert.equal(ask().agent, 'second', 'A disabled first agent is not the default');
  assert.throws(() => ask('first'), refused('agent_unavailable'));
  config({ first: claude(), second: claude({ enabled: false }) });
  assert.throws(() => ask(), refused('agent_unavailable'), 'The conversation agent is not swapped for the first enabled one');
  assert.equal(ask('first').agent, 'first');
  conversation.id = owner.clear(conversation.id).id;
  config({ first: claude({ enabled: false }) });
  assert.throws(() => ask(), { code: 'invalid_settings', reason: { kind: 'no_configured_agents' } });
});

test('a continued session keeps its values and asks again instead of defaulting a removed value', t => {
  const { owner, conversation, config, ask } = fixture(t);
  config({ first: claude() });
  assert.equal(owner.read().previousValues, null, 'No Run yet: the screen starts from the defaults');
  const first = ask(undefined, { model: 'synthetic-b' });
  assert.equal(first.agent, 'first');
  assert.deepEqual(first.previousValues, { model: 'synthetic-b', effort: null }, 'The screen shows what an omitted choice keeps');
  // The next message continues that session; only its previous synthetic-b, not the default synthetic-a, is now gone.
  config({ first: claude({ params: { model: ['synthetic-a'], effort: [] } }) });
  assert.throws(() => ask(), refused('selection_required'), 'A removed previous value is not replaced by the default');
  const chosen = ask(undefined, { model: 'synthetic-a' });
  assert.equal(chosen.agent, 'first', 'An explicit choice of a current value continues');
  assert.deepEqual(chosen.previousValues, { model: 'synthetic-a', effort: null }, 'A waiting message\'s choice is the next one\'s previous value');
  assert.throws(() => ask(undefined, { model: null }), refused('invalid_selection'), 'Leaving a row out is offered only by a written -');
  config({ first: { adapter: 'codex', params: { model: [], effort: [], fast: [] } } });
  assert.throws(() => ask(), refused('new_conversation_required'), 'A session never continues on another adapter');
  conversation.id = owner.clear(conversation.id).id;
  assert.equal(ask().agent, 'first', 'The refusal\'s recovery: a cleared conversation starts anew on the new adapter');
});

test('skill discovery reads the admitted toolset value, not the argv reference', async t => {
  const f = fixture(t), directory = join(f.root, 'synthetic-claude');
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  t.after(() => { if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original; });
  mkdirSync(join(directory, 'skills/one'), { recursive: true });
  writeFileSync(join(directory, 'skills/one/SKILL.md'), '---\nname: synthetic-skill\ndescription: Synthetic\n---\nBody');
  const setting = (toolset: string) => claude({ params: { model: [], effort: [], toolset: [toolset] }, options: {
    base: 'a'.repeat(64), start: '--tools {toolset}', resume: '--tools {toolset} --resume {session}',
  } });
  f.config({ first: setting('default') });
  const visible = await f.owner.skills(f.conversation.id, 'first');
  assert.equal(visible.status, 'ready');
  assert.ok(visible.skills.some(skill => skill.name === 'synthetic-skill'));
  f.config({ first: setting('Bash') });
  assert.equal((await f.owner.skills(f.conversation.id, 'first')).status, 'unavailable');
});

test('a queued sessionless Codex catalog keeps the conversation selection instead of its default', async t => {
  const f = fixture(t), home = join(f.root, 'synthetic-home'), directory = join(home, 'codex');
  const before = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; process.env.CODEX_HOME = directory;
  t.after(() => { for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  mkdirSync(join(directory, 'skills/.system'), { recursive: true });
  writeFileSync(join(directory, 'skills/.system/.codex-system-skills.marker'), 'synthetic-system');
  mkdirSync(join(directory, 'skills/one'));
  writeFileSync(join(directory, 'skills/one/SKILL.md'), '---\nname: synthetic-skill\ndescription: Synthetic\n---\nBody');
  f.config({ first: { adapter: 'codex', params: { model: [], effort: [], fast: [],
    cfg: ['model_verbosity=low', 'skills.config=[]', 'model_verbosity=high'] }, options: { base: optionsBase('codex'),
    start: '-c {cfg} -s danger-full-access -o {result}',
    resume: '-c {cfg} -s danger-full-access resume -o {result} -- {session}',
  } } });
  assert.equal((await f.owner.skills(f.conversation.id, 'first')).status, 'ready');
  f.ask('first', { cfg: 'skills.config=[]' });
  const store = new RunStore(f.root, { busyTimeoutMs: 0 });
  try {
    const queued = store.read()[0]!;
    assert.equal(queued.state, 'queued'); assert.equal(queued.session, null);
    assert.equal(queued.launch.values.cfg, 'skills.config=[]');
  } finally { store.close(); }
  assert.deepEqual(await f.owner.skills(f.conversation.id, 'first'),
    { status: 'unavailable', profile: 'first', skills: [], reason: 'launch' });
  const continued = f.ask('first');
  assert.equal(continued.previousValues?.cfg, 'skills.config=[]');
  f.ask('first', { cfg: 'model_verbosity=high' });
  assert.equal((await f.owner.skills(f.conversation.id, 'first')).status, 'ready');
});

test('literal command paths agree across launch, continuation, coordinator restart and skill discovery', async t => {
  const before = Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const f = fixture(t), home = join(f.root, 'home'), bin = join(home, '{tools}', '{model}', '{session}');
  mkdirSync(bin, { recursive: true });
  Object.assign(process.env, { PATH: bin, HOME: home, CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') });
  for (const folder of [join(home, 'codex', 'skills/.system'), join(home, 'claude', 'skills/one')]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(home, 'codex', 'skills/.system/.codex-system-skills.marker'), 'synthetic');
  mkdirSync(join(home, 'codex', 'skills/one'));
  for (const kind of ['claude', 'codex']) writeFileSync(join(home, kind, 'skills/one/SKILL.md'), '---\nname: one\ndescription: Synthetic\n---\nBody');
  for (const adapter of ['claude', 'codex'] as const) for (const explicit of [false, true]) {
    const command = join(bin, adapter);
    writeFileSync(command, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const initial = defaultAgentSetting(adapter);
    const setting = { ...initial, adapter, params: { ...initial.params, model: ['synthetic-model'] }, ...(explicit ? { command } : {}) };
    f.config({ chosen: setting });
    const config = parseAgentsSettings(stringify({ agents: { chosen: setting } }));
    const start = launchSnapshot(config, 'chosen', 'start', bin); assert.ok(start.ok);
    const continued = launchSnapshot(config, 'chosen', 'resume', bin, {}, start.launch); assert.ok(continued.ok);
    const coordinator = coordinatorLaunchSnapshot(config, 'chosen', 'start', bin); assert.ok(coordinator.ok);
    const resumed = coordinatorLaunchSnapshot(config, 'chosen', 'resume', bin, {}, coordinator.launch); assert.ok(resumed.ok);
    assert.ok(resumed.restartArgv);
    for (const launch of [start.launch, continued.launch, coordinator.launch, resumed.launch, { ...resumed.launch, argv: resumed.restartArgv }]) {
      const argv = launchArgv({ launch, session: { provider: adapter, id: 'synthetic-session' } }, '/synthetic-run');
      assert.equal(argv[adapter === 'claude' ? 0 : 3], command);
      assert.ok(argv.includes('synthetic-model'), 'editable option references still resolve');
      assert.ok(!argv.includes('{result}') && !argv.includes('{session}'), 'system option references still resolve');
    }
    const skills = await f.owner.skills(f.conversation.id, 'chosen');
    assert.equal(skills.status, 'ready', `${adapter}, command ${explicit ? 'explicit' : 'from PATH'}`);
    assert.deepEqual(skills.skills.map(skill => skill.name), ['one']);
  }
});
