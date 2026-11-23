import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, lstatSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSetupAgents } from '@alpacawork/backend/test-dist/installation/setup-ai.js';
import { initializeInstallation } from '@alpacawork/backend/test-dist/installation/setup.js';
import { readControlEnvironment } from '@alpacawork/backend/test-dist/control/tree.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { readServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { randomUUID } from 'node:crypto';
import { inspectAgentSkillLinks, syncAgentSkillLinks } from '@alpacawork/backend/test-dist/installation/agent-skill-links.js';
import { skillLinkConflicts, confirmInstallation } from '@alpacawork/backend/test-dist/installation/confirmation.js';
import { installationTerminal } from './helpers/installation-terminal.ts';

import { syntheticStatusBridge } from './helpers/agent-inspection.ts';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'setup-environment-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, root: join(home, '.agents/skills') };
}
test('new installations expose detected placement choices and admit coordinator messages without a saved stack', async t => {
  for (const commands of [[], ['codex'], ['claude'], ['codex', 'claude']]) {
    const { home } = fixture(t), bin = join(home, 'bin'); mkdirSync(bin);
    // The synthetic CLI accepts only the model-free authentication/version checks.
    const invoked = join(home, 'provider-was-started');
    for (const command of commands) writeFileSync(join(bin, command), `#!${process.execPath}\n` +
      `if (process.env.OPENAI_API_KEY === 'terminal-only') process.exit(1); if (!['--version','auth status','login status'].includes(process.argv.slice(2).join(' '))) { require('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'unexpected execution'); process.exit(99); }\n`, { mode: 0o700 });
    // Non-executable files and directories must not become active AI profiles.
    if (!commands.includes('claude')) writeFileSync(join(bin, 'claude'), '', { mode: 0o600 });
    if (!commands.includes('codex')) mkdirSync(join(bin, 'codex'));
    const request = { cwd: home, explicit: join(home, 'data'), env: {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: 'missing:bin', OPENAI_API_KEY: 'terminal-only',
    } };
    const { root } = await initializeInstallation({ ...request, agentEnvironment: { cwd: home, env: { HOME: home, PATH: 'missing:bin' }, bridge: syntheticStatusBridge(home) } });
    const config = readFileSync(join(root, 'config.yaml'), 'utf8');
    const expected = ['claude', 'codex'].filter(command => commands.includes(command));
    assert.deepEqual(readControlEnvironment(root).profiles.map(profile => profile.key), expected);
    const path = process.env.PATH;
    process.env.PATH = bin;
    try {
      const owner = new CoordinatorConversation(root), conversation = owner.read(), id = randomUUID();
      const ask = () => owner.ask({ conversationId: conversation.id, id, text: 'Synthetic first message', attachments: [] });
      if (expected.length) {
        assert.equal(conversation.nextLaunch?.agent, expected[0]);
        assert.equal(conversation.nextLaunch?.values.effort, 'low');
        assert.equal(ask().turns.find(turn => turn.id === id)?.status, 'queued');
      } else {
        assert.equal(conversation.nextLaunch, null);
        assert.throws(ask, { code: 'invalid_settings', reason: { kind: 'no_configured_agents' } });
      }
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    const settings = await readServerSettings(root);
    assert.ok(settings.hash);
    assert.equal(Object.hasOwn(settings, 'coordinatorAiStack'), false);
    await assert.rejects(initializeInstallation({ ...request, env: { ...request.env, PATH: '' } }), { code: 'invalid_root' });
    assert.equal(readFileSync(join(root, 'config.yaml'), 'utf8'), config, 'Later initialization cannot overwrite the saved default');
    assert.equal(existsSync(invoked), false, 'Detection and admission never invoke a model');
  }
});
for (const commands of [[], ['codex'], ['claude'], ['codex', 'claude']]) test(`AI detection: ${commands.join(',') || 'neither'}`, async t => {
  const { home } = fixture(t), bin = join(home, 'bin'); mkdirSync(bin);
  for (const command of commands) writeFileSync(join(bin, command), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  writeFileSync(join(bin, 'not-executable'), '', { mode: 0o600 });
  const agents = detectSetupAgents(home, { PATH: 'missing:bin' }); assert.deepEqual(agents, ['claude', 'codex'].filter(command => commands.includes(command)));
  for (const lang of ['ja', 'en']) {
    const io = installationTerminal('\r'); io.value.env = { LANG: lang };
    await confirmInstallation({ workspace: join(home, 'data'), releases: join(home, 'releases'), existing: false, service: 'test service', agents, skills: [] }, io.value);
    for (const command of commands) assert(io.shown().includes(command));
    assert(io.shown().includes(commands.length ? commands[0]! : lang === 'ja' ? '見つかりません' : 'None found'));
  }
});
const basic = { place: ['alpacawork' as const], remove: [] };
const inspect = (root: string, detected: readonly string[] = []) => inspectAgentSkillLinks(root, basic.place, detected);
/** The kinds that do not read ~/.agents/skills themselves, each with the folder that shows a HOME uses it. */
const linked = [['claude', '.claude']] as const, commands = linked.map(([agent]) => agent);
test('a HOME without a linked agent gets no plan and no agent folder', t => {
  const f = fixture(t); assert.deepEqual(inspect(f.root), []); syncAgentSkillLinks(f.root, basic, []);
  assert.deepEqual(inspect(f.root), []); for (const [, config] of linked) assert.equal(existsSync(join(f.home, config)), false);
});
test('an agent that reads ~/.agents/skills itself gets no link, in use or found', t => {
  const f = fixture(t); mkdirSync(join(f.home, '.codex'));
  assert.deepEqual(inspect(f.root, ['codex']), []); syncAgentSkillLinks(f.root, basic, ['codex']);
  assert.deepEqual(readdirSync(join(f.home, '.codex')), []);
});
test('links stay in the HOME that owns the root; another root gets none even when the commands were found', t => {
  const f = fixture(t), root = join(f.home, 'elsewhere/skills'); for (const [, config] of linked) mkdirSync(join(f.home, config, 'skills'), { recursive: true });
  assert.deepEqual(inspect(root, commands), []); syncAgentSkillLinks(root, basic, commands);
  for (const [, config] of linked) { assert.deepEqual(readdirSync(join(f.home, config, 'skills')), []); assert.equal(existsSync(join(f.home, 'elsewhere', config)), false); }
});
test('each linked agent a HOME uses gets its own link, and one conflict does not stop the others', t => {
  const f = fixture(t), target = join(f.root, 'alpacawork'), paths = linked.map(([, config]) => join(f.home, config, 'skills/alpacawork'));
  mkdirSync(target, { recursive: true }); for (const path of paths) mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(paths[0]!, 'keep');
  assert.deepEqual(inspect(f.root), paths.map((path, index) => ({ path, target, action: index ? 'create' : 'conflict' })));
  syncAgentSkillLinks(f.root, basic, []);
  assert.deepEqual(inspect(f.root), paths.map((path, index) => ({ path, target, action: index ? 'keep' : 'conflict' })));
  rmSync(paths[0]!); syncAgentSkillLinks(f.root, basic, []); for (const path of paths) assert.equal(readlinkSync(path), target);
  syncAgentSkillLinks(f.root, { place: [], remove: ['alpacawork'] }, []); for (const path of paths) assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined);
});
for (const [agent, config] of linked) {
for (const kind of ['command found, no folder', 'folder without skills'] as const) test(`${agent} skills folder and link are confirmed, then created: ${kind}`, async t => {
  const f = fixture(t), detected = kind === 'command found, no folder' ? [agent] : [], parent = join(f.home, config, 'skills'), path = join(parent, 'alpacawork'), target = join(f.root, 'alpacawork');
  if (!detected.length) mkdirSync(join(f.home, config));
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), 'managed');
  const links = inspect(f.root, detected); assert.deepEqual(links, [{ path, target, action: 'create-folder' }]);
  for (const lang of ['ja', 'en']) {
    const io = installationTerminal('\x03'); io.value.env = { LANG: lang };
    assert.equal((await confirmInstallation({ existing: false, workspace: join(f.home, 'data'), releases: join(f.home, 'releases'), service: 'test service', agents: [], skills: [], links }, io.value)).approved, false);
    assert(io.shown().includes(lang === 'ja' ? `${path} からリンク` : `linked from ${path}`));
    assert.equal(existsSync(parent), false); assert.equal(existsSync(join(f.home, config)), !detected.length);
  }
  syncAgentSkillLinks(f.root, basic, detected);
  assert.equal(readlinkSync(path), target); assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'managed');
  // Once the folder exists, the same HOME needs no detection.
  assert.deepEqual(inspect(f.root), [{ path, target, action: 'keep' }]);
});
for (const kind of ['absent', 'same', 'directory', 'file', 'different', 'broken'] as const) test(`${agent} link inspection, cancellation and placement: ${kind}`, async t => {
  const f = fixture(t), parent = join(f.home, config, 'skills'), path = join(parent, 'alpacawork'), target = join(f.root, 'alpacawork'); mkdirSync(parent, { recursive: true }); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'SKILL.md'), 'managed');
  if (kind === 'same') symlinkSync('../../.agents/skills/alpacawork', path);
  if (kind === 'directory') { mkdirSync(path); writeFileSync(join(path, 'keep'), 'keep'); }
  if (kind === 'file') writeFileSync(path, 'keep');
  if (kind === 'different') symlinkSync(parent, path);
  if (kind === 'broken') symlinkSync(join(f.home, 'missing'), path);
  const before = lstatSync(path, { throwIfNoEntry: false }), links = inspect(f.root), link = links[0]!;
  assert.equal(links.length, 1); assert.equal(link.action, kind === 'absent' ? 'create' : kind === 'same' ? 'keep' : 'conflict');
  for (const lang of ['ja', 'en']) {
    const io = installationTerminal('\x03'); io.value.env = { LANG: lang };
    assert.equal((await confirmInstallation({ existing: false, workspace: join(f.home, 'data'), releases: join(f.home, 'releases'), service: 'test service', agents: [], skills: [], links }, io.value)).approved, false);
    if (link.action === 'create') assert(io.shown().includes(lang === 'ja' ? `${path} からリンク` : `linked from ${path}`));
    if (link.action === 'keep') assert(io.shown().includes(lang === 'ja' ? `${path} からの既存リンク` : `existing link from ${path}`));
    if (link.action === 'conflict') assert(io.shown().includes(lang === 'ja' ? `${path} は使用中です` : `${path} is in use`));
    assert.equal(lstatSync(path, { throwIfNoEntry: false })?.ino, before?.ino);
  }
  const approved = installationTerminal('\r');
  assert.equal((await confirmInstallation({ existing: false, workspace: join(f.home, 'data'), releases: join(f.home, 'releases'), service: 'test service', agents: [], skills: [], links }, approved.value)).approved, true);
  syncAgentSkillLinks(f.root, basic, []);
  const placed = inspect(f.root)[0]!;
  assert.equal(placed.action, kind === 'absent' || kind === 'same' ? 'keep' : 'conflict');
  for (const lang of ['ja', 'en'] as const) assert.deepEqual(skillLinkConflicts([placed], lang),
    placed.action === 'keep' ? [] : [lang === 'ja' ? `${path}：リンク未作成・既存の内容を保持` : `${path}: Link not created; existing content preserved`]);
  if (before) assert.equal(lstatSync(path).ino, before.ino);
  if (kind === 'directory') assert.equal(readFileSync(join(path, 'keep'), 'utf8'), 'keep');
  if (kind === 'file') assert.equal(readFileSync(path, 'utf8'), 'keep');
  if (kind === 'broken') assert.equal(readlinkSync(path), join(f.home, 'missing'));
  if (placed.action === 'keep') { assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'managed'); const ino = lstatSync(path).ino; syncAgentSkillLinks(f.root, basic, []); assert.equal(lstatSync(path).ino, ino); }
  // Removing the skill removes only the link this product made.
  syncAgentSkillLinks(f.root, { place: [], remove: ['alpacawork'] }, []);
  assert.equal(lstatSync(path, { throwIfNoEntry: false })?.ino, placed.action === 'keep' ? undefined : before!.ino);
});
}
test('a new occupant after confirmation is preserved', t => {
  const f = fixture(t); mkdirSync(join(f.home, '.claude/skills'), { recursive: true }); const link = inspect(f.root)[0]!;
  assert.equal(link.action, 'create'); writeFileSync(link.path, 'arrived after inspection'); syncAgentSkillLinks(f.root, basic, []);
  assert.equal(inspect(f.root)[0]!.action, 'conflict'); assert.equal(readFileSync(link.path, 'utf8'), 'arrived after inspection');
});
