import { expect, test } from 'vitest';
import { actualPaint, responseAcceptance, responseStats } from '../../../e2e/stamp-response-metrics';

test('response gate uses both adopted relative formulas; 80 groups remains separately reported', () => {
  const ten = (n: number) => Array.from({ length: 10 }, () => n);
  const candidate = { 0: ten(110), 20: ten(137.5), 80: ten(900) }, main = { 0: ten(80), 20: ten(102), 80: ten(100) };
  const accepted = responseAcceptance(candidate, main);
  expect(accepted.comparisons.every(c => c.pass)).toBe(true); expect(accepted.growth.pass).toBe(true);
  expect(accepted.boundary80.candidate.median).toBe(900);
  expect(responseAcceptance({ ...candidate, 20: ten(137.501) }, main).growth.pass).toBe(false);
  expect(responseAcceptance({ ...candidate, 0: ten(110.001) }, main).comparisons[0]!.pass).toBe(false);
  expect(() => responseStats([1, 2])).toThrow('ten');
  expect(() => responseStats([...ten(1).slice(1), NaN])).toThrow('finite');
  expect(responseStats([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toMatchObject({ median: 5.5, p95: 10 });
});

test('actual Paint must belong to the observed frame and occur before copy removal', () => {
  const mark = (message: string, ts: number) => ({ name: 'TimeStamp', ts, args: { data: { message, frame: 'main' } } });
  const trace = [mark('response-append', 110_000), mark('response-first-observation', 130_000),
    { name: 'Paint', ts: 131_000, args: { data: { frame: 'main' } } }, mark('response-remove', 1_100_000)];
  const clocks = { press: 100, append: 110, firstObservation: 130, remove: 1100 };
  expect(actualPaint(trace, clocks)).toMatchObject({ pressToAppend: 10, appendToObservation: 20, pressToPaint: 31 });
  expect(() => actualPaint(trace.filter(e => e.name !== 'Paint'), clocks)).toThrow('No actual Paint');
  expect(() => actualPaint([...trace, { name: 'Paint', ts: 120_000, args: { data: { frame: 'main' } } }], clocks)).toThrow('before first observation');
  expect(() => actualPaint(trace.map(e => e.name === 'Paint' ? { ...e, args: { data: { frame: 'other' } } } : e), clocks)).toThrow('No actual Paint');
});
