import { beforeAll, expect, test } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
import type { ControlRunDTO, PlacementDTO } from '@alpacawork/contract/control';
import { endAgents } from '../src/domain/end-agent';
beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });

const placement = (id: string, taskId: string, fields: Partial<PlacementDTO> = {}) =>
  ({ id, taskId, agentId: `A${id}`, profileKey: 'claude', responsible: true, active: true, revision: 1, startedAt: '2026-11-01T00:00:00.000Z', endedAt: null, ...fields }) as PlacementDTO;
const run = (id: string, placementId: string, at: string, modelId: string, effort: string) =>
  ({ id, placementId, agent: 'claude', modelId, effort, createdAt: at, startedAt: at }) as ControlRunDTO;
const people = (placements: PlacementDTO[], runs: ControlRunDTO[]) => ({
  placements: new Map(placements.map(each => [each.id, each])),
  runsByPlacement: new Map(placements.map(each => [each.id, runs.filter(r => r.placementId === each.id)])),
});

test('every end is named by the agent that stood there: the record\'s own Run first, then the placement\'s Run at that time', () => {
  const agent = endAgents(people([placement('P1', 'T1'), placement('P2', 'T2', { startedAt: '2026-11-02T00:00:00.000Z' })], [
    run('R1', 'P1', '2026-11-01T01:00:00.000Z', 'opus', 'high'), run('R2', 'P1', '2026-11-01T03:00:00.000Z', 'sonnet', 'low')]));
  const at = '2026-11-01T02:00:00.000Z';
  // The Run the record links wins.
  expect(agent({ party: 'child', taskId: 'T1', profileKey: 'codex', modelId: 'gpt-6.1-sol', effort: 'high' }, at, 'to')).toBe('gpt-6.1-sol(high)');
  // Unlinked: who it came from is the Run it was written in, who it went to the Run that takes it in.
  expect(agent({ party: 'child', taskId: 'T1' }, at, 'from')).toBe('opus(high)');
  expect(agent({ party: 'child', taskId: 'T1' }, at, 'to')).toBe('sonnet(low)');
  // Nothing after: the latest before; a placement without a Run: its agent, unknown.
  expect(agent({ party: 'parent', taskId: 'T1' }, '2026-11-01T04:00:00.000Z', 'to')).toBe('sonnet(low)');
  expect(endAgents(people([placement('P3', 'T3')], []))({ party: 'parent', taskId: 'T3' }, at, 'to')).toBe('claude(unknown)');
  // Placed after the record, or no placement at all: no agent; you and an unlinked Coordinator are no placement.
  expect(agent({ party: 'other', taskId: 'T2' }, at, 'to')).toBeUndefined();
  expect(agent({ party: 'other', taskId: 'T9' }, at, 'to')).toBeUndefined();
  expect(agent({ party: 'you' }, at, 'from')).toBeUndefined();
  expect(agent({ party: 'coordinator' }, at, 'to')).toBeUndefined();
});

test('a member end is named by a member placement, the responsible end by the responsible one', () => {
  const agent = endAgents(people([placement('P1', 'T1'), placement('P4', 'T1', { responsible: false, profileKey: 'codex' })], [
    run('R1', 'P1', '2026-11-01T01:00:00.000Z', 'opus', 'high'), { ...run('R4', 'P4', '2026-11-01T01:00:00.000Z', 'gpt-6.1-sol', 'medium'), agent: 'codex' }]));
  const at = '2026-11-01T02:00:00.000Z';
  expect(agent({ party: 'self', taskId: 'T1', role: 'member' }, at, 'to')).toBe('gpt-6.1-sol(medium)');
  expect(agent({ party: 'self', taskId: 'T1' }, at, 'from')).toBe('opus(high)');
});

test('Run selection keeps inclusive ties, directional fallbacks and startedAt over createdAt', () => {
  const at = (hour: number) => `2026-11-01T0${hour}:00:00.000Z`;
  const missingStart = run('R-missing', 'P1', at(4), 'missing-start', 'high');
  Reflect.deleteProperty(missingStart, 'startedAt');
  // Unsorted input; equal starts keep their original order in the cached stable sort.
  const agent = endAgents(people([placement('P1', 'T1')], [
    run('R-first', 'P1', at(3), 'first-tie', 'high'),
    { ...run('R-late', 'P1', at(1), 'late', 'high'), startedAt: at(5) },
    { ...run('R-early', 'P1', at(2), 'early', 'high'), startedAt: null },
    run('R-tied', 'P1', at(3), 'last-tie', 'high'),
    missingStart,
  ]));
  const end = { party: 'child', taskId: 'T1' } as const;
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(agent(end, at(1), 'from')).toBe('early(high)');
    expect(agent(end, at(1), 'to')).toBe('early(high)');
    expect(agent(end, at(3), 'from')).toBe('last-tie(high)');
    expect(agent(end, at(3), 'to')).toBe('first-tie(high)');
    expect(agent(end, at(4), 'from')).toBe('missing-start(high)');
    expect(agent(end, at(4), 'to')).toBe('missing-start(high)');
    expect(agent(end, at(6), 'from')).toBe('late(high)');
    expect(agent(end, at(6), 'to')).toBe('late(high)');
    expect(agent(end, '2026-11-01T02:30:00.000Z', 'from')).toBe('early(high)');
    expect(agent(end, '2026-11-01T03:30:00.000Z', 'to')).toBe('missing-start(high)');
  }
  const empty = endAgents(people([placement('P1', 'T1')], []));
  expect(empty(end, at(3), 'from')).toBe('claude(unknown)');
  expect(empty(end, at(3), 'to')).toBe('claude(unknown)');
});

test('standing placement keeps role priority, earliest start and original order while excluding other times and profiles', () => {
  const at = '2026-11-01T02:00:00.000Z';
  const entries = [
    placement('ended', 'T1', { endedAt: at }),
    placement('future', 'T1', { startedAt: '2026-11-01T03:00:00.000Z' }),
    placement('member', 'T1', { responsible: false }),
    placement('later', 'T1', { startedAt: '2026-11-01T01:00:00.000Z' }),
    placement('first', 'T1'),
    placement('tied', 'T1'),
    placement('other-profile', 'T1', { profileKey: 'codex' }),
  ];
  const agent = endAgents(people(entries, entries.map(each => run(`R-${each.id}`, each.id, at, each.id, 'high'))));
  expect(agent({ party: 'self', taskId: 'T1' }, at, 'from')).toBe('first(high)');
  expect(agent({ party: 'self', taskId: 'T1', role: 'member' }, at, 'from')).toBe('member(high)');
  expect(agent({ party: 'self', taskId: 'T1', profileKey: 'codex' }, at, 'from')).toBe('other-profile(high)');
});

test('an older row is said by the Run of its own time, though the live index holds only the latest Run, whichever page brought the older', () => {
  const live = people([placement('P1', 'T1')], [run('R9', 'P1', '2026-11-01T09:00:00.000Z', 'opus', 'low')]);
  const crew = (runs: [string, string, string, string][]) => ({ placements: [{ id: 'P1', profileKey: 'claude', responsible: true, startedAt: '2026-11-01T00:00:00.000Z', endedAt: null }],
    runs: runs.map(([id, at, modelId, effort]) => ({ id, placementId: 'P1', agent: 'claude', modelId, effort, at })) });
  const agent = endAgents(live, [['T1', crew([['R2', '2026-11-01T02:00:00.000Z', 'sonnet', 'high'], ['R9', '2026-11-01T09:00:00.000Z', 'opus', 'low']])],
    ['T1', crew([['R1', '2026-11-01T01:00:00.000Z', 'haiku', 'medium']])]]);
  expect(agent({ party: 'child', taskId: 'T1' }, '2026-11-01T02:30:00.000Z', 'from')).toBe('sonnet(high)');
  expect(agent({ party: 'child', taskId: 'T1' }, '2026-11-01T01:30:00.000Z', 'from')).toBe('haiku(medium)');
  expect(agent({ party: 'child', taskId: 'T1' }, '2026-11-01T09:30:00.000Z', 'from')).toBe('opus(low)');
});
