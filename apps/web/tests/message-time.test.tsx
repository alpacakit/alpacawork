import { expect, test, vi } from 'vitest';

test('a thread shares two formatters instead of constructing one per message', async () => {
  vi.resetModules();
  const { messageTime } = await import('../src/features/coordinator/message-time');
  const formatter = vi.spyOn(Intl, 'DateTimeFormat');
  for (let n = 0; n < 80; n++) messageTime(new Date(2026, 9, 1, 0, n).toISOString(), 'ja-JP');
  expect(formatter).toHaveBeenCalledTimes(2);
});
