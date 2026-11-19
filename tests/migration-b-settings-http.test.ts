import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { start } from '../e2e/server.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';

test('settings: attachment MiB survives real config saves and reads', async () => {
  const runtime = await start();
  try {
    const read = async () => {
      const response = await fetch(`${runtime.origin}/api/config/get`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const disk = () => parse(readFileSync(join(runtime.root, 'config.yaml'), 'utf8'));
    const save = async (config: object) => {
      const current = await read();
      return fetch(`${runtime.origin}/api/config/set`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: stringify(config), agents: current.agentsText, expectedConfigHash: current.hash }) });
    };
    const initial = await read();
    assert.equal(initial.limits.attachment_mib, 50);
    assert.equal(disk().limits?.attachment_mib, undefined);
    const invalid = await save({ limits: { ...initial.limits, attachment_mib: 501 } });
    assert.equal(invalid.status, 400);
    assert.equal(disk().limits?.attachment_mib, undefined);
    const limits = { ...initial.limits, attachment_mib: 80 };
    assert.equal((await save({ limits })).status, 200);
    assert.equal(disk().limits.attachment_mib, 80);
    assert.equal((await read()).limits.attachment_mib, 80);
  } finally { await runtime.stop(); }
});
