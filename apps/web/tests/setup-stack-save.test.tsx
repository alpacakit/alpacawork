import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { aiStackSchema, type AgentAvailability } from '@alpacawork/contract';
import { configSetInput } from '@alpacawork/contract/inputs';
import { randomUUID } from 'node:crypto';
import { fixtureAgentSetting, installAgentStub } from '../../../tests/helpers/agent-stub.ts';
import { initializeControlFixture } from '../../../tests/helpers/control-fixture.ts';
import { readServerSettings, saveServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { readControlEnvironment } from '@alpacawork/backend/test-dist/control/tree.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { RunStore } from '@alpacawork/runs';
import { readServerAgents } from '../src/features/panels/server-agent-draft';
import { firstAgentOf, startAgents, usableAgents } from '../src/features/setup/rules';
import { setupSave } from '../src/features/setup/save';

const roots: string[] = [];
// The fixture points PATH at its stub agents: each test gets the PATH it started with back.
const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ready: AgentAvailability = { command: '/bin/x', version: null, candidates: [], status: 'ready', nextAction: null, issue: null };

/**
 * A test-only workspace whose agents are listed claude (offering a low effort), then codex (not offering one). The saved
 * tasks' stack starts on claude unless another order is given, or is absent when the order is null; the input's is absent.
 */
async function workspace(order: readonly ('claude' | 'codex')[] | null = ['claude', 'codex']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-setup-stack-')));
  roots.push(root);
  initializeControlFixture(root);
  installAgentStub(root, 'alpacawork-agent');
  const claude = fixtureAgentSetting('claude'), codex = fixtureAgentSetting('codex');
  claude.params = { ...claude.params, model: ['fable', 'opus'], effort: ['high', 'medium', 'low'] };
  codex.params = { ...codex.params, model: ['gpt-6.2-sol'], effort: ['high'], fast: ['-'] };
  writeFileSync(join(root, 'config.yaml'), stringify({ limits: { parallel: 4 }, agents: { claude, codex },
    ...(order === null ? {} : { aiStack: order.map(agent => agent === 'claude' ? { agent, values: { model: 'opus', effort: 'high' } }
      : { agent, values: { model: 'gpt-6.2-sol', effort: 'high', fast: null } }) }) }));
  return root;
}
/**
 * Leaves the setup's agents step with these switches and this first AI through the real config/set save. Answers the
 * saved tasks' stack, the input's stack, the first choice a placement offers, and the agent and values the first message
 * of a new conversation is admitted with.
 */
async function leaveSetup(root: string, on: Record<string, boolean>, picked: string | null) {
  const loaded = await readServerSettings(root);
  const drafts = readServerAgents(loaded.agentsText);
  if (!drafts.ok) throw new Error('unreadable');
  const rows = startAgents(drafts.value.agents, { availability: { claude: ready, codex: ready } }, false);
  const first = firstAgentOf(usableAgents(rows, on), picked, loaded.aiStack);
  const saving = setupSave(loaded, drafts.value, rows, on, first);
  if (saving) await saveServerSettings(root, configSetInput.parse({ config: saving.config, agents: saving.agents, expectedConfigHash: loaded.hash }));
  const saved = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
  const stack = aiStackSchema.optional().parse(saved.aiStack)?.map(row => row.agent);
  const coordinator = aiStackSchema.optional().parse(saved.coordinatorAiStack);
  const offered = readControlEnvironment(root).profiles[0]?.key ?? null;
  if (!first) return { stack, coordinator, offered, admitted: null };
  const conversation = new CoordinatorConversation(root), message = randomUUID();
  conversation.ask({ id: message, conversationId: conversation.read().id, text: 'Plan the next meeting.', attachments: [] });
  const store = RunStore.openReadable(root, { busyTimeoutMs: 3000 })!;
  try {
    const run = store.read().find(run => run.requestId === message);
    return { stack, coordinator, offered, admitted: run ? { agent: run.agent, values: run.launch.values } : null };
  }
  finally { store.close(); }
}

const codexRow = { agent: 'codex', values: { model: 'gpt-6.2-sol', effort: 'high', fast: null } };

test('the first AI chosen in setup is row 1 of the tasks\' stack and the agent a new conversation is admitted to', async () => {
  // The input's stack stays unsaved and runs on that agent; codex offers no low effort, so on its first values.
  expect(await leaveSetup(await workspace(), { claude: true, codex: true }, 'codex'))
    .toEqual({ stack: ['codex', 'claude'], coordinator: undefined, offered: 'codex', admitted: codexRow });
  // Switching the old first one off saves too: its rows leave the stack rather than holding the save back.
  expect(await leaveSetup(await workspace(), { claude: false, codex: true }, 'codex'))
    .toMatchObject({ stack: ['codex'], coordinator: undefined, offered: 'codex', admitted: { agent: 'codex' } });
  // Going on with no agent empties the tasks' stack, rather than leaving rows that would refuse the save.
  expect(await leaveSetup(await workspace(), { claude: false, codex: false }, null)).toEqual({ stack: [], coordinator: undefined, offered: null, admitted: null });
});

test("the input's AI starts on the chosen agent's first model at low effort where it offers low, and the first message runs so", async () => {
  const root = await workspace(null);
  const left = await leaveSetup(root, { claude: true, codex: true }, 'claude');
  expect(left.stack).toEqual(['claude']);
  expect(left.coordinator).toBeUndefined();
  expect(left.admitted).toMatchObject({ agent: 'claude', values: { model: 'fable', effort: 'low' } });
});
