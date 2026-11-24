import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { checkAgentsText } from '@alpacawork/contract';
import { runRecordSchema } from '@alpacawork/contract/run';
import { AGENTS_TEMPLATE, parseAgentsSettings, launchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { record } from './runs-fixtures.ts';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';

for (const agent of ['claude', 'codex'] as const)
  test(`${agent}: activity uses the frozen adapter with a renamed profile`, t => {
    assert.doesNotMatch(AGENTS_TEMPLATE, /activity:/);
    const raw = parse(AGENTS_TEMPLATE);
    const profile = raw.agents[agent];
    profile.adapter = agent;
    profile.command = '/usr/bin/false';
    const text = stringify({ agents: { renamed_profile: profile } });
    assert.deepEqual(checkAgentsText(text).issues, []);
    const settings = parseAgentsSettings(text);
    const snapshot = launchSnapshot(settings, 'renamed_profile', 'start', '/bin');
    assert.ok(snapshot.ok);
    assert.equal(snapshot.launch.adapter, agent);
    const restored = runRecordSchema.parse(record('R1', { launch: snapshot.launch }));
    const folder = mkdtempSync(join(tmpdir(), 'activity-config-free-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const reader = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS[restored.launch.adapter]);
    const emit = (value: unknown) => {
      appendFileSync(join(folder, 'stdout.log'), JSON.stringify(value) + '\n');
      reader.poll(folder);
      return readRunActivity(folder);
    };
    const command = 'alpacawork task get --task T157 --log 0';
    const start = agent === 'claude'
      ? { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'one', name: 'Bash', input: { command } }] } }
      : { type: 'item.started', item: { id: 'one', type: 'command_execution', command } };
    const activity = emit(start);
    assert.equal(activity?.doing?.command, 'task.get');
    assert.equal(activity?.steps[0]?.text, command);
    assert.equal(emit({ type: 'unrecognized' })?.doing?.command, 'task.get');
    const end = agent === 'claude' ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one' }] } }
      : { type: 'item.completed', item: { id: 'one', type: 'command_execution' } };
    assert.equal(emit(end)?.doing, null);
    if (agent === 'claude') {
      const helper = structuredClone(start);
      helper.parent_tool_use_id = 'helper';
      assert.equal(emit(helper)?.doing?.command, null, 'helper commands are not coordinator work');
    }
    reader.finish(folder);
    assert.equal(readRunActivity(folder)?.doing, null);
  });
