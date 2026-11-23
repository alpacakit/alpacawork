import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { configSetInput } from '@alpacawork/contract/inputs';
import { initializeControlFixture } from '../../../tests/helpers/control-fixture.ts';
import { readServerSettings, saveServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { serverAgentDraftSchema, serverAgentsYaml } from '../src/features/panels/server-agent-draft';
import { configYaml, serverDraft } from '../src/features/panels/settings-draft';
import { moveRow, rowChoices, withRowValue } from '../src/features/panels/ai-stack-draft';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Saves the Server tab as it was read, changing nothing, the way its Save button does. */
async function saveAsRead(root: string) {
  const read = await readServerSettings(root);
  const draft = serverDraft(read);
  const checked = serverAgentDraftSchema.safeParse(draft);
  expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true);
  const agents = serverAgentsYaml(draft);
  if (!agents.ok) throw new Error('unreadable agents');
  await saveServerSettings(root, configSetInput.parse({ config: configYaml(draft), agents: agents.value, expectedConfigHash: read.hash }));
  return readServerSettings(root);
}

/** Copilot and Pi at their defaults, and opus, whose launch leaves effort out, chosen with an effort it does not use. */
const claude = { params: { model: ['opus', 'sonnet'], effort: ['low', 'high'] }, without: { opus: ['effort'] } };
const rows = () => [{ agent: 'claude', values: { model: 'opus', effort: 'low' } }, { agent: 'copilot', values: {} }, { agent: 'pi', values: {} }];
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-stack-roundtrip-')));
  roots.push(root);
  initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { copilot: {}, pi: {}, claude }, aiStack: rows(), coordinatorAiStack: rows() }));
  return root;
}
/** What the Server tab sends of a draft: its two AI stacks, as config/set receives them. */
const sent = (draft: ReturnType<typeof serverDraft>) => parse(configYaml(draft)) as { aiStack: unknown; coordinatorAiStack: unknown };

test('both AI stacks are sent back as they were read, values a model leaves unused included, and a reorder below leaves a row untouched', async () => {
  const root = workspace();
  const read = await readServerSettings(root);
  expect(sent(serverDraft(read))).toMatchObject({ aiStack: read.aiStack, coordinatorAiStack: read.coordinatorAiStack });
  expect(read.coordinatorAiStack![0]).toEqual({ agent: 'claude', values: { model: 'opus', effort: 'low' } });
  const again = await saveAsRead(root);
  expect(again.aiStack).toEqual(read.aiStack);
  expect(again.coordinatorAiStack).toEqual(read.coordinatorAiStack);
  // Only the rows below move: the first is sent as it came.
  const draft = serverDraft(again);
  const moved = { ...draft, coordinatorAiStack: moveRow(draft.coordinatorAiStack, 1, 1) };
  expect((sent(moved).coordinatorAiStack as unknown[])[0]).toEqual(again.coordinatorAiStack![0]);
});

test('a value the agent stops offering, one its model leaves unused, is shown to choose again and keeps the save back, on the screen as on serve', async () => {
  const root = workspace();
  const read = await readServerSettings(root);
  const draft = serverDraft(read);
  if (!draft.agents.ok) throw new Error('unreadable agents');
  // `low` leaves claude's efforts.
  const agents = { ...draft.agents.value, agents: draft.agents.value.agents.map(agent => agent.name !== 'claude' ? agent
    : { ...agent, params: agent.params.map(row => row.key === 'effort' ? { ...row, values: 'high' } : row) }) };
  const edited = { ...draft, agents: { ok: true as const, value: agents } };
  const claudeDraft = agents.agents.find(agent => agent.name === 'claude')!;
  const row = edited.coordinatorAiStack[0]!;
  expect(rowChoices(claudeDraft, row.values).find(choice => choice.key === 'effort')).toMatchObject({ refused: true, value: 'low', candidates: ['high'] });
  expect(serverAgentDraftSchema.safeParse(edited).success).toBe(false);
  const yaml = serverAgentsYaml(edited);
  if (!yaml.ok) throw new Error('unwritable agents');
  await expect(saveServerSettings(root, configSetInput.parse({ config: configYaml(edited), agents: yaml.value, expectedConfigHash: read.hash })))
    .rejects.toMatchObject({ code: 'invalid_settings' });
  // Chosen again in both lists, it saves.
  const chosen = { ...edited, aiStack: edited.aiStack.map((each, at) => at ? each : withRowValue(each, 'effort', 'high')),
    coordinatorAiStack: edited.coordinatorAiStack.map((each, at) => at ? each : withRowValue(each, 'effort', 'high')) };
  expect(serverAgentDraftSchema.safeParse(chosen).success).toBe(true);
  const saved = await saveServerSettings(root, configSetInput.parse({ config: configYaml(chosen), agents: yaml.value, expectedConfigHash: read.hash }));
  expect(saved.coordinatorAiStack![0]).toEqual({ agent: 'claude', values: { model: 'opus', effort: 'high' } });
});

test('the last agent can be switched off: with none enabled, both lists save empty, and an enabled agent needs a row again', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-stack-empty-')));
  roots.push(root);
  initializeControlFixture(root);
  const rows = [{ agent: 'copilot', values: {} }];
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { copilot: {} }, aiStack: rows, coordinatorAiStack: rows }, { aliasDuplicateObjects: false }));
  const read = await readServerSettings(root);
  const draft = serverDraft(read);
  if (!draft.agents.ok) throw new Error('unreadable agents');
  const off = { ...draft, aiStack: [], coordinatorAiStack: [],
    agents: { ok: true as const, value: { ...draft.agents.value, agents: draft.agents.value.agents.map(agent => ({ ...agent, enabled: false })) } } };
  expect(serverAgentDraftSchema.safeParse(off).success).toBe(true);
  expect(serverAgentDraftSchema.safeParse({ ...off, agents: draft.agents }).success).toBe(false);
  // The empty lists go with the save, rather than leaving the rows that name the agent switched off.
  expect(parse(configYaml(off))).toMatchObject({ aiStack: [], coordinatorAiStack: [] });
  const agents = serverAgentsYaml(off);
  if (!agents.ok) throw new Error('unwritable agents');
  const saved = await saveServerSettings(root, configSetInput.parse({ config: configYaml(off), agents: agents.value, expectedConfigHash: read.hash }));
  expect(saved.aiStack ?? []).toEqual([]);
  expect(saved.coordinatorAiStack ?? []).toEqual([]);
});

test('with no tasks\' list saved, editing only the input\'s list saves, for agents without a model row and a model that leaves effort out', async () => {
  const claude = { params: { model: ['opus', 'sonnet'], effort: ['low', 'high'] }, without: { opus: ['effort'] } };
  for (const agents of [{ copilot: {} }, { pi: {} }, { claude }]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-stack-unsaved-')));
    roots.push(root);
    initializeControlFixture(root);
    writeFileSync(join(root, 'config.yaml'), stringify({ agents }));
    const read = await readServerSettings(root);
    const draft = serverDraft(read);
    // The input's list gets its first row, as its own "Add" does; the tasks' list is the one the editor started.
    const edited = { ...draft, coordinatorAiStack: [{ ...draft.aiStack[0]!, id: 'input-row' }] };
    const checked = serverAgentDraftSchema.safeParse(edited);
    expect(checked.success, `${Object.keys(agents)[0]}: ${JSON.stringify(checked.error?.issues)}`).toBe(true);
    const yaml = serverAgentsYaml(edited);
    if (!yaml.ok) throw new Error('unwritable agents');
    const saved = await saveServerSettings(root, configSetInput.parse({ config: configYaml(edited), agents: yaml.value, expectedConfigHash: read.hash }));
    expect(saved.coordinatorAiStack).toEqual(saved.aiStack);
  }
});
