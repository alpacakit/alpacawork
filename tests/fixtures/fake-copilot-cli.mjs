/** A runtime the Copilot SDK spawns over stdio. It records what it was asked and answers a method named in FAKE_COPILOT_HOLD only once that method's gate file exists. */
import { appendFileSync, existsSync } from 'node:fs';

const log = process.env.FAKE_COPILOT_LOG, held = JSON.parse(process.env.FAKE_COPILOT_HOLD ?? '{}');
const note = row => appendFileSync(log, `${JSON.stringify(row)}\n`);
note({ spawned: process.pid });
setTimeout(() => process.exit(9), 60_000);
const answers = { 'auth.getStatus': () => ({ isAuthenticated: process.env.FAKE_COPILOT_AUTH === 'ready' }), connect: () => ({ protocolVersion: 3 }), 'session.detach': () => ({ success: true }),
  'session.create': params => ({ sessionId: params.sessionId }), 'session.resume': params => ({ sessionId: params.sessionId }) };
const send = message => {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const handle = ({ id, method, params }) => {
  note({ method });
  if (id === undefined) return;
  const reply = () => send(method === 'auth.getStatus' && process.env.FAKE_COPILOT_AUTH === 'error'
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'Synthetic status failure' } }
    : { jsonrpc: '2.0', id, result: answers[method]?.(params) ?? {} });
  if (!held[method]) { reply(); return; }
  const poll = setInterval(() => { if (existsSync(held[method])) { clearInterval(poll); reply(); } }, 5);
};
let buffer = Buffer.alloc(0);
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
    buffer = buffer.subarray(end + 4 + size);
    handle(message);
  }
});
