import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { automationExamples } from '@alpacawork/contract/automation-program-assets';
import { prepareAutomationVersion } from '@alpacawork/backend/test-dist/automations/bundle-store.js';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';

test('the distributed automation examples pass the save checks', t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-automation-examples-'));
  const path = process.env.PATH;
  t.after(() => {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PATH = installAgentStub(root, 'claude');
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { claude: fixtureAgentSetting('claude') } }));
  const kinds = ['signal', 'host.pressure', 'task.message', 'task.state_changed', 'schedule'].sort();
  const prepared = automationExamples.map(({ name, files }) => {
    try { return prepareAutomationVersion(root, [...files]); }
    catch (cause) { throw new Error('The distributed example failed the save checks: ' + name, { cause }); }
  });
  assert.deepEqual(prepared.map(({ config }) => config.on.event).sort(), kinds);
});
