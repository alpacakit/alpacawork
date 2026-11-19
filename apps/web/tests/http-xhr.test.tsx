import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, expect, vi } from 'vitest';
import { httpXHR, type XhrFault } from './http-xhr';

test('real HTTP bytes and a callback exception keep their separate XHR meanings and original cause', async () => {
  const bytes: Buffer[] = [];
  const server = createServer((req, res) => {
    req.on('data', chunk => bytes.push(Buffer.from(chunk)));
    req.once('end', () => { res.writeHead(201); res.end('actual reply'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const faults: XhrFault[] = [], cause = new Error('caller callback failed');
    let loaded!: () => void;
    const done = new Promise<void>(resolve => { loaded = resolve; });
    const XHR = httpXHR(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      hold: () => Promise.resolve(), sent() {}, loaded, fault: fault => faults.push(fault),
    });
    const xhr = new XHR(); xhr.open('POST', '/bytes'); xhr.onerror = vi.fn(); xhr.onload = () => { throw cause; };
    xhr.send(new File(['real bytes'], 'bytes.txt')); await done;
    expect(Buffer.concat(bytes).toString()).toBe('real bytes');
    expect(xhr.status).toBe(201); expect(xhr.responseText).toBe('actual reply');
    expect(xhr.onerror).not.toHaveBeenCalled();
    expect(faults).toEqual([{ phase: 'callback', method: 'POST', path: '/bytes', cause }]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
