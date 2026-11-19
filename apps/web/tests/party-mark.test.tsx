import { expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { Icon } from '../src/components/ui/icon';

const shape = (name: 'member' | 'thisTask') => render(<Icon name={name} />).container.querySelector(`[data-icon="${name}"]`)!.firstElementChild!;

test('a member is a hollow ring, its line thicker than the set, so it is not the filled square of its Task nor an unread dot', () => {
  const ring = shape('member');
  expect(ring.tagName).toBe('circle');
  expect(ring.getAttribute('fill')).toBeNull();
  expect(ring.getAttribute('stroke')).toBeNull();
  expect(Number(ring.getAttribute('stroke-width'))).toBeGreaterThan(1.5);
  const square = shape('thisTask');
  expect(square.tagName).toBe('rect');
  expect(square.getAttribute('fill')).toBe('currentColor');
});
