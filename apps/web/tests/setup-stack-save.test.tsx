import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AgentAvailability } from '@alpacawork/contract';
import { configSetInput } from '@alpacawork/contract/inputs';
import { randomUUID } from 'node:crypto';
import { fixtureAgentSetting, installAgentStub } from '../../../tests/helpers/agent-stub.ts';
import { initializeControlFixture } from '../../../tests/helpers/control-fixture.ts';
import { readServerSettings, saveServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { readControlEnvironment } from '@alpacawork/backend/test-dist/control/tree.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { createLaunchMemory } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { RunStore } from '@alpacawork/runs';
import { readServerAgents } from '../src/features/panels/server-agent-draft';
import { firstAgentOf, startAgents, usableAgents } from '../src/features/setup/rules';
import { setupSave } from '../src/features/setup/save';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ready: AgentAvailability = { command: '/bin/x', version: null, candidates: [], status: 'ready', nextAction: null, issue: null };

/** A test-only workspace whose saved AI stack is claude, then codex, and whose person last chose claude in the input. */
async function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-setup-stack-')));
  roots.push(root);
  initializeControlFixture(root);
  installAgentStub(root, 'alpacawork-agent');
  const claude = fixtureAgentSetting('claude'), codex = fixtureAgentSetting('codex');
  claude.params = { ...claude.params, model: ['opus', 'fable'], effort: ['high', 'medium'] };
  codex.params = { ...codex.params, model: ['gpt-6.2-sol'], effort: ['high'], fast: ['-'] };
  writeFileSync(join(root, 'config.yaml'), stringify({ limits: { parallel: 4 }, agents: { claude, codex },
    aiStack: [{ agent: 'claude', values: { model: 'opus', effort: 'high' } }, { agent: 'codex', values: { model: 'gpt-6.2-sol', effort: 'high', fast: null } }] }));
  await createLaunchMemory(root).change({ kind: 'choose', agent: 'claude', values: {} });
  return root;
}
/**
 * Leaves the setup's agents step with these switches and this first AI through the real config/set save, then lets go of
 * the remembered agent as the step does. Answers the saved stack, the first choice the input offers, and the agent the
 * first message of a new conversation is admitted to.
 */
async function leaveSetup(root: string, on: Record<string, boolean>, picked: string | null) {
  const loaded = await readServerSettings(root);
  const drafts = readServerAgents(loaded.agentsText);
  if (!drafts.ok) throw new Error('unreadable');
  const rows = startAgents(drafts.value.agents, { availability: { claude: ready, codex: ready } }, false);
  const first = firstAgentOf(usableAgents(rows, on), picked);
  const saving = setupSave(loaded, drafts.value, rows, on, first);
  if (saving) await saveServerSettings(root, configSetInput.parse({ config: saving.config, agents: saving.agents, expectedConfigHash: loaded.hash }));
  await createLaunchMemory(root).change({ kind: 'forget-agent' });
  const stack = (await readServerSettings(root)).aiStack?.map(row => row.agent);
  const offered = readControlEnvironment(root).profiles[0]?.key ?? null;
  if (!first) return { stack, offered, admitted: null };
  const conversation = new CoordinatorConversation(root), message = randomUUID();
  conversation.ask({ id: message, conversationId: conversation.read().id, text: 'Plan the next meeting.', attachments: [], selected: {} });
  const store = RunStore.openReadable(root, { busyTimeoutMs: 3000 })!;
  try { return { stack, offered, admitted: store.read().find(run => run.requestId === message)?.agent ?? null }; }
  finally { store.close(); }
}

test('the first AI chosen in setup is row 1 of the saved stack and the agent a new conversation is admitted to', async () => {
  expect(await leaveSetup(await workspace(), { claude: true, codex: true }, 'codex'))
    .toEqual({ stack: ['codex', 'claude'], offered: 'codex', admitted: 'codex' });
  // Switching the old first one off saves too: its rows leave the stack rather than holding the save back.
  expect(await leaveSetup(await workspace(), { claude: false, codex: true }, 'codex'))
    .toEqual({ stack: ['codex'], offered: 'codex', admitted: 'codex' });
  // Going on with no agent empties the stack, rather than leaving rows that would refuse the save.
  expect(await leaveSetup(await workspace(), { claude: false, codex: false }, null)).toEqual({ stack: [], offered: null, admitted: null });
});
