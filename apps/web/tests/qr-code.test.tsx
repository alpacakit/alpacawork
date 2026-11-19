import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { QrCode, generateQrCode } from '../src/components/ui/qr-code';

afterEach(cleanup);

test('SVG has an accessible name, fixed white background, black modules and a four-module quiet zone', () => {
  const view = render(<QrCode value="https://pc.example-tail.ts.net:8443/" label="スマホで開く" className="phone-code" />);
  const svg = view.getByRole('img', { name: 'スマホで開く' });
  expect(svg.getAttribute('class')).toBe('phone-code');
  expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
  expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#000');
  const size = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  expect(svg.getAttribute('style')).toContain(`min-width: ${size * 4}px`);
  expect(svg.getAttribute('style')).toContain(`min-height: ${size * 4}px`);
  const modules = [...svg.querySelector('path')!.getAttribute('d')!.matchAll(/M(\d+),(\d+)h1v1h-1z/g)];
  expect(modules.length).toBeGreaterThan(100);
  expect(Math.min(...modules.map(module => Number(module[1])))).toBe(4);
  expect(Math.min(...modules.map(module => Number(module[2])))).toBe(4);
  expect(Math.max(...modules.map(module => Number(module[1])))).toBe(size - 5);
  expect(Math.max(...modules.map(module => Number(module[2])))).toBe(size - 5);
});

test('oversized and malformed Unicode inputs expose generation failure without dropping the surrounding screen', () => {
  for (const value of ['x'.repeat(5000), '\ud800']) {
    const result = generateQrCode(value);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.error).toBeDefined();
    const view = render(<div>Manual URL<QrCode value={value} label="QR" /></div>);
    expect(view.getByText('Manual URL')).toBeDefined();
    expect(view.queryByRole('img')).toBeNull();
    view.unmount();
  }
});
