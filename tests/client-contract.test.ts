import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CLI_CONTRACT, CONTRACT_HEADER, clientContractRefusal } from '@alpacawork/contract/client-contract';
import { problemSchema } from '@alpacawork/contract/problem';
import { errorBody, digestBytes } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { cliRepairCommand } from '@alpacawork/backend/test-dist/installation/skills-update-command.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';

test('the CLI contract accepts only its number and returns an old-CLI-readable refusal with local repair guidance', () => {
  const version = '0.3.0', command = cliRepairCommand(version);
  assert.equal(clientContractRefusal(String(CLI_CONTRACT), version, () => command), null);
  // Compatible clients must not construct repair guidance, even for an unpublished development version.
  assert.equal(clientContractRefusal(String(CLI_CONTRACT), 'development', () => cliRepairCommand('development')), null);
  for (const sent of [null, '0', String(CLI_CONTRACT + 1), '1.0', 'garbage']) {
    const refusal = clientContractRefusal(sent, version, () => command)!;
    assert.ok(refusal);
    // problemSchema and its reason union are unchanged from the old CLI. No new reason is needed.
    const body = problemSchema.parse(errorBody(refusal));
    assert.equal(body.error.code, 'invalid_input');
    assert.equal(body.error.retry, 'fix');
    assert.equal(body.error.reason, undefined);
    assert.ok(body.error.message.includes(version));
    assert.ok(body.error.message.includes(sent ?? 'missing'));
    assert.ok(body.error.message.includes(command));
    assert.deepEqual(body.error.detail, { serverVersion: version, serverContract: CLI_CONTRACT, clientContract: sent, command });
  }
});

test('the receivers refuse mismatched or missing CLI contracts before reads, command writes or file writes; screen requests pass', async t => {
  receiverClock(t);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'client-contract-')));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { claude: fixtureAgentSetting('claude') } }));
  const project = initializeControlFixture(root);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false,
    tasks: [{ title: 'Synthetic contract check' }] })).tasks[0]!;
  const folder = join(root, 'tasks', task.id, 'work');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'note.txt'), bytes = 'Synthetic private task data';
  writeFileSync(file, bytes);
  server = await startServer(root, 0);
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  t.after(() => store.close());
  const snapshot = () => store.read(db => Object.fromEntries(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => [String(row.name), db.prepare(`SELECT * FROM "${row.name}"`).all()])));
  const before = snapshot();
  const paths = [`/api/task/get?task=${task.id}`, `/api/task/get?task=${task.id}&files=true`,
    `/api/tasks/${task.id}/file?path=work/note.txt`];
  for (const sent of [null, String(CLI_CONTRACT + 1)]) {
    const headers = { 'X-Alpacawork-Client': 'cli', ...(sent === null ? {} : { [CONTRACT_HEADER]: sent }) };
    for (const path of paths) {
      const response = await fetch(new URL(path, server.url), { headers });
      assert.equal(response.status, 400, path);
      const body = problemSchema.parse(await response.json());
      assert.equal(body.error.code, 'invalid_input');
      assert.ok(!JSON.stringify(body).includes(bytes));
      assert.ok(!('task' in body));
    }
    const opId = randomUUID();
    const write = await fetch(new URL('/api/task/comment', server.url), { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': opId },
      body: JSON.stringify({ task: task.id, title: 'Must never be saved', expectedTaskHash: task.hash, opId }) });
    assert.equal(write.status, 400);
    assert.equal(problemSchema.parse(await write.json()).error.code, 'invalid_input');
    const replacement = 'Must never replace the file';
    const upload = await fetch(new URL(paths[2]!, server.url), { method: 'PUT', headers: { ...headers,
      'X-Alpacawork-Op-Id': randomUUID(), 'X-Alpacawork-Content-Digest': digestBytes(Buffer.from(replacement)) }, body: replacement });
    assert.equal(upload.status, 400);
    assert.equal(problemSchema.parse(await upload.json()).error.code, 'invalid_input');
    assert.equal(readFileSync(file, 'utf8'), bytes);
    assert.deepEqual(snapshot(), before);
  }
  for (const headers of [{}, { 'X-Alpacawork-Client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT) }]) {
    for (const path of paths) {
      const response = await fetch(new URL(path, server.url), { headers });
      assert.equal(response.status, 200, await response.text());
    }
  }
});
