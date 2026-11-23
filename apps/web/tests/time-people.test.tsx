import { describe, expect, it } from 'vitest';
import { indexPeople } from '@/domain/people';
import { timeHistoryBase, type BelowRun } from '@/domain/time-history';
import { belowOf, chronologyKey, newTimeProjectionHeld, projectTimePeople, timeHistories, timeHistoryBases } from '@/features/tree/time-people';
import { lineOf } from '@/features/tree/time-line';
import { keepSame, type Held } from '@/lib/keep-same';

const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const log = (id: string, minute: number) => ({ id, at: at(minute), toState: 'doing', fromState: 'todo', kind: 'reported' });
const row = (id: string, state = 'doing') => ({ id, parentId: null, createdAt: at(0), state, stateLog: [], ball: { kind: 'none' }, notice: { logCount: 0 } });
const peopleOf = (tasks: ReturnType<typeof row>[]) => indexPeople({ tasks, placements: [], runs: [] } as never);
const lane = (id: string, minutes: number[], belowRuns: [string, number, number][] = []) => ({ lane: id, row: row(id), anchor: null, placements: [], belowRuns,
  events: minutes.map(minute => ({ kind: 'log', taskId: id, entry: log(`${id}-${minute}`, minute) })) }) as never;

describe('keepSame', () => {
  it('keeps a value that says the same, replaces one that does not, and forgets what is gone', () => {
    const held: Held<{ n: number }> = new Map();
    const [a, b] = keepSame(held, [['a', { n: 1 }], ['b', { n: 2 }]]);
    const [againA, changedB] = keepSame(held, [['a', { n: 1 }], ['b', { n: 3 }]]);
    expect(againA).toBe(a);
    expect(changedB).not.toBe(b);
    expect(changedB).toEqual({ n: 3 });
    keepSame(held, [['a', { n: 1 }]]);
    expect([...held.keys()]).toEqual(['a']);
  });
});

describe('the time projection', () => {
  it('reading the chronology again leaves the rows it did not change as they were', () => {
    const people = peopleOf([row('T1'), row('T2')]);
    const held = newTimeProjectionHeld(), bases = new Map(), histories = new Map();
    const first = projectTimePeople(people, [lane('T1', [1]), lane('T2', [2])], held);
    const firstBases = timeHistoryBases(first.timePeople, first.notes, new Map(), bases);
    const firstHistories = timeHistories(firstBases, 1000, histories);
    const second = projectTimePeople(people, [lane('T1', [1]), lane('T2', [2, 3])], held);
    const secondBases = timeHistoryBases(second.timePeople, second.notes, new Map(), bases);
    const secondHistories = timeHistories(secondBases, 1000, histories);
    expect(second.timePeople.tasks.get('T1')).toBe(first.timePeople.tasks.get('T1'));
    expect(secondHistories.get('T1')).toBe(firstHistories.get('T1'));
    expect(second.timePeople.tasks.get('T2')).not.toBe(first.timePeople.tasks.get('T2'));
    expect(second.timePeople.tasks.get('T2')!.stateLog.map((each: { id: string }) => each.id)).toEqual(['T2-2', 'T2-3']);
    expect(secondHistories.get('T2')).not.toBe(firstHistories.get('T2'));
  });

  it('a line counts the Runs under its row, as its running count does: ended ones from the shown window, running ones from the row', () => {
    const at = (minute: number) => Date.parse('2026-10-10T10:00:00Z') + minute * 60_000;
    // Two Runs began at 40 under T1: R3 ended (in the window), R8 still runs (on the row); both count. R1 ended at 20,
    // and the window says so before the row has: it is counted once, ended.
    const people = peopleOf([{ ...row('T1'), runsBelow: [['R7', at(30)], ['R8', at(40)], ['R1', at(10)]] } as never, row('T2')]);
    const held = newTimeProjectionHeld(), bases = new Map(), histories = new Map();
    const { timePeople, notes } = projectTimePeople(people, [], held);
    const shown = { lanes: [], below: new Map() };
    const below = belowOf([lane('T1', [], [['R1', at(10), at(20)], ['R2', at(15), at(25)], ['R3', at(40), at(45)]])], shown);
    const lines = timeHistories(timeHistoryBases(timePeople, notes, below, bases), at(50), histories);
    const line = lines.get('T1')!;
    // The Runs under it reach back past the row's own creation (a child moved in): its line starts with them.
    expect(line.start).toBe(at(10));
    const stretches = lineOf(line, at(50), { x: (time: number) => (time - at(0)) / 1000, from: at(0), to: at(50), width: 3000 }).stretches;
    expect(stretches.map(each => [each.from, each.count])).toEqual([[at(10), 1], [at(15), 2], [at(20), 1], [at(25), 0], [at(30), 1], [at(40), 3], [at(45), 2]]);
  });

  it('the Runs under a row are read from the range shown now; a row not read for it yet keeps the last it was read with', () => {
    const at = (minute: number) => Date.parse('2026-10-10T10:00:00Z') + minute * 60_000;
    const shown = { lanes: [], below: new Map() };
    expect(belowOf([lane('T1', [], [['R1', at(10), at(20)]])], shown).get('T1')).toHaveLength(1);
    // R1's Task moved from under T1 to under T2: both rows are read again, and say so.
    const moved = belowOf([lane('T1', []), lane('T2', [], [['R1', at(10), at(20)]])], shown);
    expect([moved.get('T1'), moved.get('T2')]).toEqual([[], [['R1', at(10), at(20)]]]);
    // Another range, where T2 is not read yet: it keeps what it was last read with.
    expect(belowOf([lane('T1', [])], shown).get('T2')).toHaveLength(1);
  });

  it('a Run begun at this instant is one that runs now, and one ended at this instant is not', () => {
    const now = Date.parse('2026-10-10T11:00:00Z');
    const people = peopleOf([{ ...row('T1'), runsBelow: [['R2', now]] } as never]);
    const { timePeople, notes } = projectTimePeople(people, [], newTimeProjectionHeld());
    const below = new Map([['T1', [['R1', now - 600_000, now]] as [string, number, number][]]]);
    const line = timeHistories(timeHistoryBases(timePeople, notes, below, new Map()), now, new Map()).get('T1')!;
    expect(line.segments.filter(each => each.kind === 'below')).toEqual([{ from: now - 600_000, to: now, kind: 'below' }, { from: now, to: now, kind: 'below', open: true }]);
  });

  it('a row with thousands of Runs under it is shaped at once, and as one pass over every stretch would shape it', () => {
    const at = (second: number) => Date.parse('2026-10-10T10:00:00Z') + second * 1000;
    const hands = Array.from({ length: 6000 }, (_, i) => ({ from: at(i), to: at(i + 0.5), kind: 'below' as const }));
    const history = { taskId: 'T1', start: at(0), end: null, events: [], segments: hands };
    const started = performance.now();
    const shaped = lineOf(history, at(6000), { x: (time: number) => (time - at(0)) / 1000, from: at(0), to: at(6000), width: 6000 }).stretches;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(shaped.map(each => each.count)).toEqual([1, 0]);
    // Zoomed in, every step parts again.
    expect(lineOf(history, at(6000), { x: (time: number) => (time - at(0)) / 50, from: at(0), to: at(6000), width: 120000 }).stretches).toHaveLength(12000);
  });

  it('finds the start of a large history without an argument-count limit, ignoring nonfinite times', () => {
    const task = { ...row('T1'), createdAt: 'invalid' };
    const { timePeople } = projectTimePeople(peopleOf([task]), [], newTimeProjectionHeld());
    // A parent can accumulate many ended Runs in its displayed window.
    const below: BelowRun[] = Array.from({ length: 150_000 }, (_, i) => [`R${i}`, i + 100, i + 101]);
    below.push(['invalid', NaN, NaN], ['unbounded', -Infinity, 0], ['earliest', 5, 6]);
    const history = timeHistoryBase(task, timePeople, [], below)!;
    expect(history.start).toBe(5);
    expect(history.segments).toHaveLength(below.length);
    expect(timeHistoryBase(task, timePeople, [], [])!.start).toBeNull();
  });

  it('omits invalid event times while keeping equal-time keys ordered and log identities', () => {
    const later = log('L2', 1), earlier = log('L1', 1);
    const task = { ...row('T1'), stateLog: [later, { ...log('bad', 2), at: 'invalid' }, earlier] };
    const history = timeHistoryBase(task, peopleOf([task as never]), [])!;
    expect(history.events.map(event => [event.key, event.at])).toEqual([
      ['log:T1:L1', Date.parse(at(1))], ['log:T1:L2', Date.parse(at(1))],
    ]);
    expect(history.events[0]!.source.log).toBe(earlier);
    expect(history.events[1]!.source.log).toBe(later);
  });

  it('the clock moves only a history still open', () => {
    const people = peopleOf([row('T1')]);
    const held = newTimeProjectionHeld(), bases = new Map(), histories = new Map();
    const { timePeople, notes } = projectTimePeople(people, [lane('T1', [1])], held);
    const base = timeHistoryBases(timePeople, notes, new Map(), bases);
    const before = timeHistories(base, 1000, histories).get('T1');
    expect(timeHistories(base, 1000, histories).get('T1')).toBe(before);
    expect(base.get('T1')?.segments.every(each => each.to !== null)).toBe(true);
    expect(timeHistories(base, 2000, histories).get('T1')).toBe(before);
  });

  it('the chronology key changes with a state and not with a title', () => {
    const one = row('T1');
    const before = chronologyKey(peopleOf([one]));
    expect(chronologyKey(peopleOf([{ ...one, title: 'Renamed' } as never]))).toBe(before);
    expect(chronologyKey(peopleOf([{ ...one, state: 'held' }]))).not.toBe(before);
  });
});
