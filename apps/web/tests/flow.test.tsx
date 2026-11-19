import { expect, test } from 'vitest';
import { reportFlow, type OpenTask } from '../src/domain/flow';
import type { ReportEvent } from '../src/domain/report-events';

const tasks: Record<string, { parentId: string | null; title: string }> = {
  T0: { parentId: null, title: 'top' }, T1: { parentId: 'T0', title: 'parent' }, T2: { parentId: 'T1', title: 'open' },
  T3: { parentId: 'T2', title: 'child' }, T4: { parentId: 'T1', title: 'sibling' },
};
const open: OpenTask = { id: 'T2', parentId: 'T1' };
const row = (fields: Partial<ReportEvent>): ReportEvent => ({ key: 'k', at: '2026-11-01T00:00:00.000Z', kind: 'comment', text: '', description: null, id: 'x', taskId: 'T2', mark: null, ...fields });
const flow = (fields: Partial<ReportEvent>) => {
  const { from, to } = reportFlow(row(fields), open, id => tasks[id]);
  return [from.party, to?.party ?? null];
};
const owner = { kind: 'owner', profileKey: 'claude' } as const;
const by = (taskId: string) => ({ kind: 'parent', taskId, profileKey: 'claude' }) as const;

test('every party and direction reads from the record links and the tree', () => {
  expect(flow({ kind: 'request', author: by('T1'), recipient: { role: 'owner', profileKey: 'claude' } })).toEqual(['parent', 'self']);
  expect(flow({ kind: 'request', author: { kind: 'human' }, by: 'human' })).toEqual(['you', 'self']);
  expect(flow({ kind: 'request', author: { kind: 'main' }, by: 'main' })).toEqual(['coordinator', 'self']);
  expect(flow({ kind: 'request', taskId: 'T3', sourceTaskId: 'T3', author: by('T2') })).toEqual(['self', 'child']);
  expect(flow({ kind: 'question', taskId: 'T3', sourceTaskId: 'T3', author: owner, askedTo: 'T2' })).toEqual(['child', 'self']);
  expect(flow({ kind: 'answer', taskId: 'T3', sourceTaskId: 'T3', author: by('T2') })).toEqual(['self', 'child']);
  expect(flow({ kind: 'report', taskId: 'T3', sourceTaskId: 'T3', author: owner })).toEqual(['child', 'self']);
  expect(flow({ kind: 'question', author: owner, askedTo: 'T1' })).toEqual(['self', 'parent']);
  expect(flow({ kind: 'question', author: owner, askedTo: 'T0' })).toEqual(['self', 'other']);
  expect(flow({ kind: 'question', author: owner, askedTo: 'user' })).toEqual(['self', 'you']);
  expect(flow({ kind: 'answer', author: by('T1') })).toEqual(['parent', 'self']);
  expect(flow({ kind: 'answer', author: by('T0') })).toEqual(['other', 'self']);
  expect(flow({ kind: 'comment', author: by('T4') })).toEqual(['other', 'self']);
  expect(flow({ kind: 'comment', author: owner })).toEqual(['self', null]);
  expect(flow({ kind: 'report', author: owner })).toEqual(['self', 'parent']);
  expect(flow({ kind: 'changed', author: { kind: 'human' }, by: 'human', changed: 'held' })).toEqual(['you', 'self']);
});

test('a report at the top of the tree goes to the user', () => {
  const top: OpenTask = { id: 'T0', parentId: null };
  const { to } = reportFlow(row({ kind: 'review', taskId: 'T0', author: owner }), top, id => tasks[id]);
  expect(to?.party).toBe('you');
});


test('both ends retain their own historical launch choices for row consumers', () => {
  const { from, to } = reportFlow(row({ kind: 'request',
    author: { ...owner, modelId: 'sonnet', effort: 'medium' },
    recipient: { role: 'member', profileKey: 'claude', modelId: 'opus', effort: 'high' },
  }), open, id => tasks[id]);
  expect(from).toMatchObject({ party: 'self', role: 'owner', profileKey: 'claude', modelId: 'sonnet', effort: 'medium' });
  expect(to).toMatchObject({ party: 'self', role: 'member', profileKey: 'claude', modelId: 'opus', effort: 'high' });
});
