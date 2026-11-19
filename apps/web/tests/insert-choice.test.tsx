import { describe, expect, it } from 'vitest';
import { choose, sideways, type Choice } from '../src/features/coordinator/editor/insert-choice';

const items: Choice[] = [
  { id: 'P273', project: { name: 'alpacawork' } },
  { id: 'P317', project: { name: 'alpacashop' } },
  { id: 'T490' },
  { id: 'T434' },
];

describe('what the # and / lists choose', () => {
  it('the first task when nothing names a project, the one the detail panel shows leading', () => {
    expect(choose(items, '')).toBe(2);
    expect(choose(items, 'a')).toBe(2);
  });
  it('a project its full P-number names', () => {
    expect(choose(items, 'p317')).toBe(1);
    expect(choose(items, 'P31')).toBe(2);
  });
  it('a project whose name starts with two characters or more of what is typed, over the item kept', () => {
    expect(choose(items, 'alpacaw', 'T434')).toBe(0);
    expect(choose(items, 'alpacas')).toBe(1);
    expect(choose(items, 'ＡＬ')).toBe(0);
  });
  it('the item already chosen while it is still listed', () => {
    expect(choose(items, 'a', 'T434')).toBe(3);
    expect(choose(items, 'a', 'P317')).toBe(1);
    expect(choose(items, 'a', 'T999')).toBe(2);
    expect(choose([{ id: 'one' }, { id: 'two' }], 'al', 'two')).toBe(1);
  });
  it('the first project when no task is left', () => {
    expect(choose(items.slice(0, 2), 'security')).toBe(0);
    expect(choose([], 'x')).toBe(0);
  });
});

describe('← and → in the # list', () => {
  it('move along the project row and stop at its ends', () => {
    expect(sideways(items, 0, 1)).toBe(1);
    expect(sideways(items, 1, 1)).toBe(1);
    expect(sideways(items, 0, -1)).toBe(0);
  });
  it('leave the caret its keys while a task is chosen', () => {
    expect(sideways(items, 2, 1)).toBeNull();
  });
});
