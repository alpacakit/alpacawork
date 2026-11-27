import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundleLifecycle, bundleHookChange, createBundleAutomation, prepareAutomationVersion, updateBundleReview } from '@alpacawork/backend/test-dist/automations/bundle-store.js';
import { receiveSignal } from '@alpacawork/backend/test-dist/automations/signals.js';
import { publishRestoreIdentity } from '@alpacawork/backend/test-dist/release/journal.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { automationHookResultSchema, automationSignalResultSchema } from '@alpacawork/contract/automation';
import { automationProgramViewResultSchema } from '@alpacawork/contract/automation-program';
import { ControlStore, controlDatabasePath } from '@alpacawork/db';
import { copyRehearsalControl } from '../scripts/dev-fixtures/rehearsal-control-copy.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { cliRun } from './helpers/http-cli.ts';
import { taskFlow } from './task-flow.fixture.ts';

const human = { kind: 'human' } as const;
const files = [{ path: 'main.ts', source: `
export const config = { on: { event: 'signal' }, limits: { perDay: 10 } };
/** Review a delivery. */
export function run() { return { summary: 'Delivery reviewed' }; }
` }];
const version = ({ id, hash }: { id: string; hash: string }) => ({ automation: id, expectedHash: hash });
function draftAt(root: string, project: string, name: string) {
  const store = new ControlStore(root);
  try { return store.write(db => {
    const at = new Date().toISOString();
    const { automation } = createBundleAutomation(db, project, name, prepareAutomationVersion(root, files), human, at);
    updateBundleReview(db, automation, automation.latest, { state: 'ok', findings: [], summary: '', reasonKind: null, model: null, at, acknowledged: null });
    return automation;
  }); }
  finally { store.close(); }
}

test('HTTP hooks authenticate one automation, share retry keys with CLI, and reserve the URL for the person', async t => {
  const f = await taskFlow(t);
  const draft = draftAt(f.root, f.project, 'Synthetic deliveries');
  const other = draftAt(f.root, f.project, 'Other deliveries');
  const server = await startServer(f.root, 0, { hostSource: { supported: false, platform: 'test' } });
  try {
    const get = (path: string, headers?: HeadersInit) => fetch(new URL(path, server.url), { headers });
    const edit = async (command: string, input: Record<string, unknown>) => {
      const response = await commandFetch(new URL('/api/commands/automation/' + command, server.url), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return { text, automation: automationProgramViewResultSchema.parse(JSON.parse(text)).automation };
    };
    const show = () => get(`/api/automations/${draft.id}/hook`);
    const reveal = async () => {
      const res = await show();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      return new URL(automationHookResultSchema.parse(await res.json()).url);
    };
    const send = (url: URL, body: string, headers: Record<string, string> = {}) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
    });
    const sendReceipt = async (response: Response, status: number) => {
      assert.equal(response.status, status);
      return automationSignalResultSchema.parse(await response.json());
    };
    const off = await send(new URL(`/hooks/${draft.id}/${randomBytes(32).toString('base64url')}`, server.url), '{}');
    assert.equal(off.status, 404);
    const missingBody = await off.text();
    assert.equal((await show()).status, 404);
    const create = await cliRun(server.url, ['automation', 'hook-create', '--automation', draft.id, '--expected-hash', draft.hash]);
    assert.equal(create.code, 0, create.stderr);
    const created = automationProgramViewResultSchema.parse(JSON.parse(create.stdout)).automation;
    assert.equal(created.hook.exists, true);
    const url = await reveal(), token = url.pathname.split('/').at(-1)!;
    const read = await cliRun(server.url, ['automation', 'hook-read', '--automation', draft.id]);
    assert.equal(read.code, 0, read.stderr);
    assert.equal(automationHookResultSchema.parse(JSON.parse(read.stdout)).url, url.href);
    const readSeed = new ControlStore(f.root, { busyTimeoutMs: 1000 }, true);
    const initialSecret = readSeed.read(db => db.prepare('SELECT automation_id,hook_token FROM automation_secrets').get()!);
    readSeed.close();
    assert.ok(!create.stdout.includes(token));
    assert.ok(!create.stdout.includes(String(initialSecret.hook_token)));
    assert.equal((await get(`/api/automations/${draft.id}/hook`, {
      'x-alpacawork-provider': 'codex', 'x-alpacawork-conversation': 'synthetic-coordinator',
    })).status, 403);
    assert.equal((await send(url, '{}')).status, 204);
    const otherAttempt = await send(new URL(`/hooks/${other.id}/${token}`, server.url), '{}');
    assert.equal(otherAttempt.status, 404);
    assert.equal(await otherAttempt.text(), missingBody);
    const enabled = (await edit('enable', { ...version(created), acknowledgeReview: true })).automation;
    const wrongKey = await send(new URL(`/hooks/${draft.id}/${randomBytes(32).toString('base64url')}`, server.url), '{}');
    assert.equal(wrongKey.status, 404);
    assert.equal(await wrongKey.text(), missingBody);
    assert.equal((await send(url, '{"s":"' + 'a'.repeat(64 * 1024) + '"}')).status, 413);


    const first = await sendReceipt(await send(url, '{"a":1,"b":2}', { 'idempotency-key': 'delivery-1', 'webhook-id': 'fallback' }), 202);
    const replay = await sendReceipt(await send(url, '{"b":2,"a":1}', { 'webhook-id': 'delivery-1' }), 200);
    assert.deepEqual(replay, { ...first, duplicate: true });
    assert.equal((await send(url, '{"a":2}', { 'idempotency-key': 'delivery-1' })).status, 409);
    const cli = await cliRun(server.url, ['automation', 'signal', '--automation', draft.id, '--key', 'delivery-1', '--data', '{"a":1,"b":2}']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(automationSignalResultSchema.parse(JSON.parse(cli.stdout)), replay);
    const store = new ControlStore(f.root, { busyTimeoutMs: 1000 }, true);
    try {
      const counts = store.read(db => db.prepare(`SELECT (SELECT count(*) FROM automation_signal_receipts) AS receipts,
        (SELECT count(*) FROM automation_runs) AS runs`).get());
      assert.deepEqual({ ...counts }, { receipts: 1, runs: 1 });
    } finally { store.close(); }

    const rotated = await edit('hook-rotate', version(enabled));
    assert.equal(rotated.automation.enabled, true);
    const replacement = await reveal();
    assert.notEqual(replacement.href, url.href);
    const expired = await send(url, '{}');
    assert.equal(expired.status, 404);
    assert.equal(await expired.text(), missingBody);
    const forReplacement = await sendReceipt(await send(replacement, '{"a":1,"b":2}', { 'idempotency-key': 'delivery-1' }), 200);
    assert.deepEqual(forReplacement, replay);

    const ordinaryRoutes = [`/api/commands/automation/get?automation=${draft.id}`, '/api/commands/automation/list',
      `/api/commands/automation/runs?automation=${draft.id}`, '/api/runtime/diagnostics'];
    const ordinary = await Promise.all(ordinaryRoutes.map(async path => {
      const response = await get(path);
      assert.equal(response.status, 200);
      return response.text();
    }));
    const view = automationProgramViewResultSchema.parse(JSON.parse(ordinary[0]!)).automation;
    assert.equal(view.hook.exists, true);
    const replacementToken = replacement.pathname.split('/').at(-1)!;
    for (const output of [rotated.text, ...ordinary]) {
      assert.ok(!output.includes(token));
      assert.ok(!output.includes(replacementToken));
    }
    const removed = await edit('hook-delete', version(rotated.automation));
    assert.equal(removed.automation.hook.exists, false);
    assert.equal((await show()).status, 404);
    assert.equal((await send(replacement, '{}')).status, 404);

    // Model recovery to a database with the original hook and no receipt for the later delivery.
    const recovered = new ControlStore(f.root);
    try {
      recovered.write(db => {
        db.prepare('INSERT INTO automation_secrets(automation_id,hook_token) VALUES (?,?)')
          .run(initialSecret.automation_id!, initialSecret.hook_token!);
        db.exec('DELETE FROM automation_signal_receipts');
      });
      publishRestoreIdentity(f.root, { id: randomUUID(), failure: join(f.root, 'unused-test-failure'), reader: 'test' });
      for (const retired of [url, replacement])
        assert.equal((await send(retired, '{"a":1,"b":2}', { 'idempotency-key': 'delivery-1' })).status, 404);
      assert.notEqual((await reveal()).href, url.href);
      assert.equal(recovered.read(db => db.prepare('SELECT count(*) AS count FROM automation_signal_receipts').get()!.count), 0);
    } finally { recovered.close(); }
  } finally {
    await server.close();
    const cache = join(f.root, '.automations');
    if (existsSync(cache)) for (const entry of readdirSync(cache, { recursive: true, withFileTypes: true }))
      if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
  }
});

test('a rehearsal copy starts off, settles a pending signal, and contains no live hook secret', async t => {
  const f = await taskFlow(t);
  const draft = draftAt(f.root, f.project, 'Pending deliveries');
  const source = new ControlStore(f.root);
  const token = source.write(db => {
    const now = new Date(), hooked = bundleHookChange(db, draft, 'create', randomBytes(32).toString('base64url'), human, now.toISOString());
    const enabled = bundleLifecycle(db, f.root, hooked, { kind: 'enabled', acknowledge: true }, human, now);
    receiveSignal(db, { automation: enabled.id }, human, randomUUID(), now);
    return String(db.prepare('SELECT hook_token FROM automation_secrets').get()?.hook_token);
  });
  source.close();

  const sandbox = mkdtempSync(join(tmpdir(), 'automation-hook-rehearsal-'));
  t.after(() => rmSync(sandbox, { force: true, recursive: true }));
  const rehearsal = join(sandbox, 'rehearsal');
  mkdirSync(rehearsal, { mode: 0o700 });
  copyRehearsalControl(f.root, rehearsal);
  const control = new ControlStore(rehearsal, { busyTimeoutMs: 1000 }, true);
  try {
    control.read(db => {
      assert.equal(db.prepare('SELECT count(*) AS count FROM automation_secrets').get()?.count, 0);
      assert.equal(db.prepare('SELECT enabled FROM automations').get()?.enabled, 0);
      assert.equal(db.prepare("SELECT reason_kind FROM automation_runs WHERE state='skipped'").get()?.reason_kind, 'off');
    });
    assert.ok(!readFileSync(controlDatabasePath(rehearsal)).includes(token));
  } finally { control.close(); }
  const unchanged = new ControlStore(f.root, { busyTimeoutMs: 1000 }, true);
  try {
    unchanged.read(db => {
      assert.equal(db.prepare('SELECT hook_token FROM automation_secrets').get()?.hook_token, token);
      assert.equal(db.prepare('SELECT enabled FROM automations').get()?.enabled, 1);
      assert.equal(db.prepare("SELECT count(*) AS count FROM automation_runs WHERE state='waiting'").get()?.count, 1);
    });
  } finally { unchanged.close(); }
});
