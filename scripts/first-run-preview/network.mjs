/** Preview-only transport boundary. Consent remains real; remote requests never leave this process. */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = dirname(process.env.HOME ?? '');
if (!/^\/tmp\/alpacawork-first-run-[A-Za-z0-9]+$/.test(root)) throw new Error('Preview transport requires its disposable HOME');
const marker = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8'));
if (marker.root !== root || marker.home !== process.env.HOME) throw new Error('Preview transport ownership mismatch');
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port !== '5499') return nativeFetch(input, init);
  appendFileSync(join(root, 'blocked-network.jsonl'), JSON.stringify({ host: url.hostname, method: init?.method ?? 'GET' }) + '\n');
  // A synthetic collector response also exercises consent-on reporting without a production account or receiver.
  if (url.hostname === 'alpacakit-telemetry.alpacakit.workers.dev') return new Response(null, { status: 204 });
  throw new Error('Remote requests are disabled in the preview');
};
