import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmInstallation, confirmUninstall, type InstallationConfirmationRequest } from '@alpacawork/backend/test-dist/installation/confirmation.js';
import { installationTerminal as terminal } from './helpers/installation-terminal.ts';
const request: InstallationConfirmationRequest = { existing: false, workspace: '/tmp/setup-data', releases: '/tmp/setup-releases',
  service: 'Register a user service; runs while logged in', agents: ['codex'],
  skills: [{ name: 'alpacawork', destination: '/tmp/setup-home/.agents/skills/alpacawork', action: 'replace' }] };
for (const answer of ['\r', '\n', 'y', 'Y', 'y\r', 'Y\n']) test(`setup approval accepts ${JSON.stringify(answer)} and restores the terminal`, async () => {
  const io = terminal(answer); const result = await confirmInstallation({ ...request, showReleases: true }, io.value);
  assert.deepEqual(result, { approved: true, request: { ...request, showReleases: true } });
  for (const value of [request.workspace, request.releases, request.service, 'codex', request.skills[0].destination]) assert(io.shown().includes(value));
  assert.equal(io.input.raw, false);
});
for (const [answer, reason] of [['\x03', 'cancelled'], [null, 'eof'], ['n', 'invalid_input'], ['N\r', 'invalid_input'], ['x', 'invalid_input'], ['yes\r', 'invalid_input']] as const)
  test(`pre-write confirmation refuses ${reason} and restores the terminal`, async () => {
    const io = terminal(answer); assert.deepEqual(await confirmInstallation(request, io.value), { approved: false, reason });
    assert.equal(io.input.raw, false); assert.equal(io.input.listenerCount('data'), 0);
  });
test('non-TTY exits without a prompt or approval, and an early Enter cannot approve', async () => {
  const pipe = terminal('\r', false); assert.deepEqual(await confirmInstallation(request, pipe.value), { approved: false, reason: 'not_terminal' });
  assert(!pipe.shown().includes('[Y/n]'));
  const early = terminal('\x03', true, true); assert.deepEqual(await confirmInstallation(request, early.value), { approved: false, reason: 'cancelled' });
});
test('hidden controls cannot change what the user approves', async () => {
  const io = terminal('\r'); await assert.rejects(confirmInstallation({ ...request, releases: '/tmp/a\nother' }, io.value), /absolute paths/);
  assert.equal(io.shown(), '');
});

test('yes prints the plan without a prompt or reading input, including outside a terminal', async () => {
  for (const tty of [false, true]) {
    const io = terminal(null, tty);
    io.input.setRawMode = () => { throw new Error('yes must never read the terminal'); };
    const approved = await confirmInstallation(request, io.value, { yes: true });
    assert.equal(approved.approved, true);
    assert(io.shown().includes(request.workspace));
    assert(!io.shown().includes('[Y/n]'));
    assert.equal(io.input.listenerCount('data'), 0);
  }
});
test('uninstall continues to require Enter rather than accepting setup approval letters', async () => {
  for (const answer of ['y', 'Y']) {
    const io = terminal(answer);
    assert.deepEqual(await confirmUninstall({ remove: [], keep: [] }, io.value), { approved: false, reason: 'invalid_input' });
  }
});

test('a re-approval shows each changed fact as old → new under its own title, in both languages, and installs nothing', async () => {
  const changes = [{ fact: 'port', from: '5601', to: '5602' }, { fact: 'publicHost', from: null, to: 'pc.tailnet.example' },
    { fact: 'node', from: '/opt/node-22/bin/node', to: '/opt/node-24/bin/node' }, { fact: 'path', from: '/usr/bin:/bin', to: '/opt/agents/bin:/usr/bin:/bin' }] as const;
  for (const lang of ['en', 'ja']) {
    const io = terminal('\r'); io.value.env = { LANG: lang };
    const result = await confirmInstallation({ ...request, existing: true, agents: [], skills: [], changes }, io.value);
    assert.equal(result.approved, true);
    for (const change of changes) {
      if (change.from) assert(io.shown().includes(change.from));
      assert(io.shown().includes(change.to));
    }
    assert(!io.shown().includes(request.skills[0].destination), 'a service change installs no skill');
  }
  const hidden = terminal('\r');
  await assert.rejects(confirmInstallation({ ...request, changes: [{ fact: 'path', from: '/usr/bin', to: '/usr/bin\x1b[2K' }] }, hidden.value), /printable/);
  assert.equal(hidden.shown(), '');
});
