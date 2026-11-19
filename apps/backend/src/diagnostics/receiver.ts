import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ENDPOINT, MAX_REQUEST_BYTES, readSample } from './protocol.ts';
import { performanceWriter } from './writer.ts';

export function createWorkspacePerformanceReceiver(root: string, buildId: string) {
  return createPerformanceReceiver(join(root, '.alpacawork/diagnostics/performance'), buildId, console.warn);
}

/** Shared by the built server and Vite. The adapter supplies its validated exact origin. */
export function createPerformanceReceiver(directory: string, buildId: string, warn: (message: string) => void) {
  const writer = performanceWriter(directory, warn);
  let active = 0, closed = false;
  const bodies = new Set<() => void>();
  return {
    handle(req: IncomingMessage, res: ServerResponse, origin: string): boolean {
      if (req.url?.split('?')[0] !== ENDPOINT) return false;
      const reject = (status: number) => { res.writeHead(status, { Connection: 'close' }); res.end(); req.resume(); };
      if (req.method !== 'POST') { reject(405); return true; }
      if (!req.headers.origin || req.headers.origin !== origin) { reject(403); return true; }
      if (closed || writer.failed) { reject(503); return true; }
      if (active >= 8) { reject(429); return true; }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reject(415); return true; }
      active++;
      let chunks: Buffer[] = [], bytes = 0, finished = false;
      const release = () => {
        if (finished) return false;
        finished = true; clearTimeout(deadline); bodies.delete(cancel); active--;
        req.off('data', data); req.off('end', end); req.off('error', cancel); res.off('close', cancel);
        chunks = []; return true;
      };
      const cancel = () => { if (release() && !res.writableEnded) reject(408); };
      const deadline = setTimeout(cancel, 2000);
      const data = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) { if (release()) reject(413); }
        else chunks.push(chunk);
      };
      const end = () => {
        let sample;
        try { sample = readSample(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* rejected below */ }
        if (!release()) return;
        if (!sample) { reject(400); return; }
        if (sample.buildId !== buildId) { reject(409); return; }
        const saved = writer.write({ at: new Date().toISOString(), ...sample });
        if (!saved) { reject(429); return; }
        void saved.then(ok => { if (!res.destroyed) { res.writeHead(ok ? 204 : 503); res.end(); } });
      };
      bodies.add(cancel);
      req.on('data', data); req.once('end', end); req.once('error', cancel); res.once('close', cancel);
      return true;
    },
    async close() { closed = true; for (const cancel of bodies) cancel(); await writer.close(); },
  };
}
