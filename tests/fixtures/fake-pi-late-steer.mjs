#!/usr/bin/env node
// Synthetic Pi RPC: models pi emitting agent_settled for run 1 before it reads a steer prompt from stdin.
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const id = '019a5555-1111-7777-8888-123456789abc', file = join(process.cwd(), 'pi-session.jsonl'), log = process.env.PI_STUB_LOG;
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
const note = row => appendFileSync(log, JSON.stringify(row) + '\n');
let streaming = false, turn = 0, buffer = '';
const settle = () => {
  writeFileSync(file, JSON.stringify({ type: 'session', id, cwd: process.cwd() }) + '\n');
  send({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: `reply ${turn}` }] } });
  send({ type: 'agent_end', willRetry: false }); send({ type: 'agent_settled', aborted: false }); streaming = false;
};
function command(row) {
  note(row);
  const response = data => send({ id: row.id, type: 'response', command: row.type, success: true, data });
  if (row.type === 'get_state') response({ sessionId: id, sessionFile: file, model: { provider: 'p', id: 'm' }, thinkingLevel: 'high', isStreaming: streaming, isCompacting: false, pendingMessageCount: 0 });
  else if (row.type === 'get_session_stats') response({ sessionId: id, sessionFile: file, tokens: { input: turn, output: turn, cacheRead: 0, cacheWrite: 0 } });
  else if (row.type === 'prompt') {
    if (streaming && row.streamingBehavior === 'steer') settle(); // run 1 finished just before this line was read
    streaming = true; turn++; send({ type: 'agent_start' });
    response({ disposition: 'started' });
    send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: row.message }] } });
    if (turn >= 2) setTimeout(settle, 50); // run 2 answers the steer text
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { buffer += c; for (let e; (e = buffer.indexOf('\n')) >= 0;) { const l = buffer.slice(0, e); buffer = buffer.slice(e + 1); if (l) command(JSON.parse(l)); } });
process.stdin.on('end', () => process.exit(0));
