import { expect, test } from 'vitest';
import { keptFrame, LEAST_HEIGHT } from '../src/features/coordinator/frame';

test('a conversation kept lower than its least height opens at its least', () => {
  localStorage.setItem('alpacawork.coordinatorFrame', JSON.stringify({ side: 'right', x: 16, edge: 'bottom', y: 12, width: 440, height: 120 }));
  expect(keptFrame.get()?.height).toBe(LEAST_HEIGHT);
});
