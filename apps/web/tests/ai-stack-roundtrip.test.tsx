import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { configSetInput } from '@alpacawork/contract/inputs';
import { initializeControlFixture } from '../../../tests/helpers/control-fixture.ts';
import { installAgentStub } from '../../../tests/helpers/agent-stub.ts';
import { readServerSettings, saveServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { serverAgentDraftSchema, serverAgentsYaml } from '../src/features/panels/server-agent-draft';
import { configYaml, serverDraft } from '../src/features/panels/settings-draft';
import { moveRow, rowChoices, withRowValue } from '../src/features/panels/ai-stack-draft';
import { beginDraftOptionsEdit, updateDraftOptions, type AgentDraft } from '../src/features/panels/agent-settings-draft';
import { optionsBase } from '@alpacawork/contract/agent-adapters';

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

test('with no input\'s list saved, it shows the row the input runs on, and a save as read writes that row', async () => {
  const claude = { params: { model: ['opus', 'sonnet'], effort: ['high', 'low'] } };
  const codex = { params: { model: ['gpt-6.2-sol'], effort: ['high', 'low'] } };
  const cases = [
    // The tasks' row 1 names codex: codex's first values at low.
    { config: { agents: { claude, codex }, aiStack: [{ agent: 'codex', values: { model: 'gpt-6.2-sol', effort: 'high' } }] },
      row: { agent: 'codex', values: { model: 'gpt-6.2-sol', effort: 'low', fast: null } } },
    // No tasks' list either: the first enabled agent, at low.
    { config: { agents: { claude, codex } }, row: { agent: 'claude', values: { model: 'opus', effort: 'low' } } },
    // A saved empty list stays empty: the input runs on nothing.
    { config: { agents: { claude }, coordinatorAiStack: [] }, row: null },
  ];
  for (const { config, row } of cases) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-stack-unsaved-')));
    roots.push(root);
    initializeControlFixture(root);
    installAgentStub(root, 'alpacawork-agent');
    writeFileSync(join(root, 'config.yaml'), stringify(config));
    const settings = readAgentsSettings(root);
    if (!settings.ok) throw settings.error;
    const shown = serverDraft(await readServerSettings(root)).coordinatorAiStack.map(({ agent, values }) => ({ agent, values }));
    expect(shown).toEqual(row ? [row] : []);
    // An empty list saved stays empty here, held back until a row is added, as before.
    if (row) expect((await saveAsRead(root)).coordinatorAiStack).toEqual([row]);
  }
});

/** An agent's card with its launch options edited as the advanced settings do: `edit` rewrites start and resume. */
function withOptions(card: AgentDraft, adapter: 'claude' | 'copilot', edit: (options: string) => string): AgentDraft {
  const editing = beginDraftOptionsEdit(card, optionsBase(adapter));
  return updateDraftOptions(editing, { ...editing.options!, start: edit(editing.options!.start), resume: edit(editing.options!.resume) });
}

test('a choice taken out of an agent\'s launch options leaves its rows only when saved so, and a value comes back with its choice', async () => {
  // Copilot's options stop naming the model: the rows keep `model: null` while edited, and are saved without it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-stack-saved-')));
  roots.push(root);
  initializeControlFixture(root);
  const copilot = [{ agent: 'copilot', values: {} }];
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { copilot: {} }, aiStack: copilot, coordinatorAiStack: copilot }, { aliasDuplicateObjects: false }));
  const read = await readServerSettings(root);
  const draft = serverDraft(read);
  if (!draft.agents.ok) throw new Error('unreadable agents');
  expect(draft.coordinatorAiStack[0]!.values).toHaveProperty('model', null);
  const card = draft.agents.value.agents[0]!;
  const edited = { ...draft, agents: { ok: true as const, value: { ...draft.agents.value,
    agents: [withOptions(card, 'copilot', options => options.replace('[-m {model}] ', ''))] } } };
  expect(edited.coordinatorAiStack[0]!.values).toHaveProperty('model', null);
  expect(sent(edited).coordinatorAiStack).toEqual([{ agent: 'copilot', values: {} }]);
  expect(serverAgentDraftSchema.safeParse(edited).success).toBe(true);
  const yaml = serverAgentsYaml(edited);
  if (!yaml.ok) throw new Error('unwritable agents');
  const saved = await saveServerSettings(root, configSetInput.parse({ config: configYaml(edited), agents: yaml.value, expectedConfigHash: read.hash }));
  expect(saved.coordinatorAiStack).toEqual([{ agent: 'copilot', values: {} }]);

  // Claude's options lose `[--effort {effort}]` while being edited, then get it back: the row's `low` is still there.
  const other = serverDraft(await readServerSettings(workspace()));
  if (!other.agents.ok) throw new Error('unreadable agents');
  const claudeCard = other.agents.value.agents.find(agent => agent.name === 'claude')!;
  const cut = withOptions(claudeCard, 'claude', options => options.replace('[--effort {effort}] ', ''));
  const back = withOptions(cut, 'claude', options => options.replace('[--model {model}] ', '[--model {model}] [--effort {effort}] '));
  for (const agent of [cut, back]) {
    const step = { ...other, agents: { ok: true as const, value: { ...other.agents.value,
      agents: other.agents.value.agents.map(each => each.name === 'claude' ? agent : each) } } };
    expect(step.coordinatorAiStack[0]!.values).toEqual({ model: 'opus', effort: 'low' });
    if (agent === back) expect((sent(step).coordinatorAiStack as unknown[])[0]).toEqual({ agent: 'claude', values: { model: 'opus', effort: 'low' } });
  }
});
