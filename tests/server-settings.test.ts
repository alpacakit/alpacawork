import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { httpStatus } from './helpers/http-cli.ts';
import { initializeControlFixture, currentTaskLog } from './helpers/control-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { checkAgentsText, DEFAULT_LIMITS, DEFAULT_SCHEMA, type Limits } from '@alpacawork/contract';
import { configSetInput } from '@alpacawork/contract/inputs';
import { Problem, errorBody, parseInput } from '@alpacawork/core';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { readServerSettings, saveServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readSchema } from '@alpacawork/backend/test-dist/control/field-commands.js';

const AGENTS = stringify({ agents: { claude: {
  ...fixtureAgentSetting('claude'), params: { model: ['opus', 'sonnet'], effort: [] },
} } }).replace('  claude:', '  # about claude\n  claude:')
  .replace('      model:\n        - opus\n        - sonnet', '      model: [opus, sonnet] # inline');
const CONFIG = `# hand-written comment stays
limits:
  parallel: 2
${AGENTS}`;
function setup(t: { after: (fn: () => void) => void }, config = CONFIG) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'server-settings-')));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(config)); project = initializeControlFixture(root); } finally { writer.close(); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project };
}
const limits: Limits = { ...DEFAULT_LIMITS, parallel: 2 };
const rest = (changes: Partial<Limits> = {}) => stringify({ limits: { ...limits, ...changes } });
const file = (root: string) => readFileSync(join(root, 'config.yaml'), 'utf8');
const save = (root: string, input: { config: string; agents: string; expectedConfigHash: string | null }) =>
  saveServerSettings(root, parseInput(configSetInput, input));

test('the agents rules pass a working block and name the line of each problem', () => {
  assert.deepEqual(checkAgentsText(AGENTS).issues, []);
  const issue = (text: string) => checkAgentsText(text).issues.map(({ line, kind, path }) => ({ line, kind, path }));
  assert.deepEqual(issue('agents:\n  claude: [unclosed\n')[0]?.kind, 'yaml');
  assert.deepEqual(issue('limits: {}\nagents: {}\n'), [{ line: 1, kind: 'top', path: '' }]);
  const duplicate = issue(AGENTS.replace('[opus, sonnet]', '[opus, opus]'));
  assert.ok(duplicate.some(item => item.line > 0 && item.path.startsWith('agents.claude.params.model')));

});

test('agent settings can change from the screen, and only the agents lines are replaced', async t => {
  const { root } = setup(t);
  const before = await readServerSettings(root);
  assert.equal(before.agentsText, AGENTS);
  const edited = AGENTS.replace('[opus, sonnet]', '[sonnet, opus]').replace('# about claude', '# edited by hand on screen')
    + stringify({ codex: fixtureAgentSetting('codex') }).split('\n').map(line => line ? '  ' + line : line).join('\n');
  const saved = await save(root, { config: rest(), agents: edited, expectedConfigHash: before.hash });
  assert.equal(file(root), CONFIG.replace(AGENTS, edited), 'every other line stays byte for byte');
  assert.equal(saved.hash, (await readServerSettings(root)).hash);
  assert.equal(saved.agentsText, edited);
});

test('a limits change keeps comments, leaves unchanged defaults unwritten, and keeps the agents block as typed', async t => {
  const { root } = setup(t);
  const before = await readServerSettings(root);
  const typed = AGENTS.replace('[opus, sonnet]', '[opus,   sonnet]');
  const saved = await save(root, { config: rest({ parallel: 3 }), agents: typed, expectedConfigHash: before.hash });
  assert(file(root).includes(typed));
  assert.equal(saved.agentsText, typed);
  assert.match(file(root), /# hand-written comment stays/);
  assert.match(file(root), /# about claude/);
  assert.match(file(root), /parallel: 3/);
  assert.doesNotMatch(file(root), /children_per_run/);
  assert.equal(saved.limits.parallel, 3);
});

test('the settings screen saves limits.attachment_mib from 1 to 500 MiB', async t => {
  const { root } = setup(t);
  const before = await readServerSettings(root);
  assert.equal(before.limits.attachment_mib, 50);
  const saved = await save(root, { config: rest({ attachment_mib: 80 }), agents: before.agentsText, expectedConfigHash: before.hash });
  assert.match(file(root), /attachment_mib: 80/);
  assert.equal((await readServerSettings(root)).limits.attachment_mib, 80);
  for (const value of [0, 501, 2.5])
    await assert.rejects(async () => save(root, { config: rest({ attachment_mib: value }), agents: saved.agentsText, expectedConfigHash: saved.hash! }),
      (error: any) => error.code === 'invalid_input' && error.issues?.some((issue: { path: string }) => issue.path === 'limits.attachment_mib'));
});

test('a project\'s name, values and fields are its Task\'s; config.yaml and its hash stay', async t => {
  const { root, project } = setup(t);
  const before = await readServerSettings(root);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const hash = async (id: string) => (await new ControlTaskStore(root).get(id)).hash;
  const nested = (await commands.create({ kind: 'project', color: '#39659b', parentId: project, userRequested: null, tasks: [{ title: 'Nested' }] })).tasks[0];
  const task = (await commands.create({ parentId: nested.id, userRequested: null, tasks: [{ title: 'Work' }] })).tasks[0];
  assert.equal(readSchema(root, task.id).from, null, 'no project has fields of its own: the default schema');
  const saved = (await commands.update({ id: project, title: 'Launch Room', values: { project_policy: 'Ship it' },
    expectedTaskHash: await hash(project) })).task;
  // One save carries the title record and the values record.
  assert.deepEqual([saved.title, saved.values, saved.version], ['Launch Room', { project_policy: 'Ship it' }, 2]);
  assert.deepEqual(currentTaskLog(root,project).slice(1).map(entry => entry.kind), ['retitled', 'body_updated']);
  // A project's own fields hold for every Task below a project that has none of its own; inheriting drops them.
  await commands.setSchema({ task: project, fields: [...DEFAULT_SCHEMA].reverse(), expectedTaskHash: await hash(project) });
  assert.equal(readSchema(root, task.id).from, project);
  await commands.setSchema({ task: project, fields: null, expectedTaskHash: await hash(project) });
  assert.equal(readSchema(root, task.id).from, null);
  assert.equal(file(root), CONFIG);
  // The screen's hash is config.yaml's bytes alone, so a project's change refuses no settings save.
  assert.equal((await readServerSettings(root)).hash, before.hash);
  assert.equal((await save(root, { config: rest({ parallel: 3 }), agents: before.agentsText, expectedConfigHash: before.hash }))
    .limits.parallel, 3);
});

test('a project name or extracts left in config.yaml are reported: they belong to the project Task now', async t => {
  for (const legacy of ['project_name: Old\n', 'extracts: []\n']) {
    const { root } = setup(t, `${legacy}${CONFIG}`);
    const settings = await readServerSettings(root);
    assert.match(settings.error?.message ?? '', /Unrecognized key/);
  }
});

test('nothing changed writes nothing; a broken block or a stale hash writes nothing', async t => {
  const { root } = setup(t);
  const first = await readServerSettings(root);
  const agentsText = first.agentsText;
  const { hash } = await save(root, { config: rest(), agents: agentsText, expectedConfigHash: first.hash });
  assert.equal(hash, first.hash);
  assert.equal((await save(root, { config: rest(), agents: agentsText, expectedConfigHash: hash })).hash, hash);
  assert.equal(file(root), CONFIG);
  await assert.rejects(async () => save(root, { config: rest(), agents: AGENTS.replace('[opus, sonnet]', '[opus, opus]'), expectedConfigHash: hash }),
    (error: any) => error.code === 'invalid_input' && error.issues?.some((issue: { path: string; params?: { line?: number } }) =>
      issue.path === 'agentsText' && (issue.params?.line ?? 0) > 0));
  await assert.rejects(async () => save(root, { config: rest({ parallel: 0 }), agents: agentsText, expectedConfigHash: hash }),
    (error: any) => error.code === 'invalid_input' && error.issues?.some((issue: { path: string }) => issue.path === 'limits.parallel'));
  await assert.rejects(save(root, { config: rest({ parallel: 3 }), agents: agentsText, expectedConfigHash: '0'.repeat(64) }),
    (error: any) => error.code === 'conflict' && error.status === 409);
  assert.equal(file(root), CONFIG);
});

test('HTTP reads and saves the server settings against the config.yaml hash', async t => {
  const { root } = setup(t);
  const server = await startServer(root, 0);
  try {
    const got = await (await fetch(new URL('/api/config/get', server.url))).json() as { hash: string; agentsText: string };
    const post = (expectedConfigHash: string, stacks = {}) => httpStatus(new URL('/api/config/set', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: stringify({ limits: { ...limits, parallel: 5 }, ...stacks }), agents: got.agentsText, expectedConfigHash }) });
    for (const key of ['aiStack', 'coordinatorAiStack']) {
      assert.equal(await post(got.hash, { [key]: [{ agent: 'claude', values: { model: 'unoffered' } }] }), 400);
    }
    assert.equal(await post(got.hash), 200);
    assert.equal(await post(got.hash), 409);
  } finally { await server.close(); }
});

test('side settings failures keep the missing file or YAML position as machine facts', async t => {
  const { root } = setup(t);
  rmSync(join(root, 'config.yaml'));
  const missing = await readServerSettings(root);
  assert.deepEqual(missing.error?.reason, { kind: 'file_missing', path: 'config.yaml' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, 'config.yaml'), 'agents: [\n');
  const invalid = await readServerSettings(root);
  assert.equal(invalid.error?.reason?.kind, 'config_invalid');
  if (invalid.error?.reason?.kind === 'config_invalid') {
    assert.equal(invalid.error.reason.path, 'config.yaml');
    assert.ok(invalid.error.reason.issues.some(issue => (issue.line ?? 0) > 0 && (issue.column ?? 0) > 0));
  }
});

test('a real stale settings save carries the settings-specific reason and reread policy without writing', async t => {
  const { root } = setup(t);
  const before = await readServerSettings(root);
  const original = file(root);
  await assert.rejects(save(root, { config: rest({ parallel: 3 }), agents: before.agentsText, expectedConfigHash: '0'.repeat(64) }), error => {
    assert.ok(error instanceof Problem);
    assert.deepEqual(errorBody(error), { error: { code: 'conflict', retry: 'reread',
      message: 'Settings changed; reload before retrying', detail: { path: 'config.yaml' }, reason: { kind: 'settings_changed' } } });
    return true;
  });
  assert.equal(file(root), original);
  const saved = await save(root, { config: rest({ parallel: 3 }), agents: before.agentsText, expectedConfigHash: before.hash });
  assert.equal(saved.limits.parallel, 3);
});
