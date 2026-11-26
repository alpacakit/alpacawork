#!/usr/bin/env node
/** Fixed-source-shaped synthetic Pi RPC. No model, authentication, or external connection. Mode compact-fail refuses compact. */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const mode = process.env.PI_STUB_MODE ?? 'normal', log = process.env.PI_STUB_LOG;
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const requested = args.includes('--session') ? value('--session') : null;
const id = mode === 'wrong-id' ? 'different-id' : requested ?? '019a5555-1111-7777-8888-123456789abc';
const file = join(process.cwd(), 'pi-session.jsonl');
const model = mode === 'wrong-model' ? 'another/model' : args.includes('--model') ? value('--model') : 'synthetic/default/model';
const slash = model.indexOf('/');
const note = row => appendFileSync(log, JSON.stringify(row) + '\n');
const send = row => process.stdout.write(JSON.stringify(row) + '\n');
const header = () => writeFileSync(file, JSON.stringify({ type: 'session', id, cwd: mode === 'wrong-cwd' ? '/tmp' : process.cwd() }) + '\n');
if (requested || mode === 'wrong-cwd') header();
note({ started: process.pid, args, env: { dir: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR } });
let started = false, finishing = false, turn = 0, sent = [], buffer = '';
if (mode === 'descendant') {
 const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
 note({ descendant: child.pid });
 process.on('SIGTERM', () => {});
}
function finish() {
 if (finishing) return; finishing = true;
 if (mode === 'retry') send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'intermediate error' }] } });
 if (mode === 'retry') send({ type: 'agent_end', willRetry: true });
 if (mode === 'cancel') send({ type: 'queue_update', steering: [], followUp: [] });
 const stop = ['error', 'length', 'aborted', 'toolUse', 'pending', 'deferred'].includes(mode) ? mode : 'stop';
 const end = () => {
  header();
  if (mode === 'normal') {
   send({ type: 'tool_execution_start', toolCallId: 'check', toolName: 'bash', args: { command: 'cat catalog.txt' } });
   send({ type: 'tool_execution_end', toolCallId: 'check', toolName: 'bash', isError: true,
    result: { content: [{ type: 'text', text: 'Catalog missing\nTry again' }] } });
  }
  if (mode === 'large-tool') {
   const tail = 'x'.repeat(3 * 1024 * 1024);
   send({ type: 'tool_execution_start', toolCallId: 'large', toolName: 'bash', args: { command: 'print catalog\n' + tail } });
   send({ type: 'tool_execution_end', toolCallId: 'large', toolName: 'bash', isError: false,
    result: { content: [{ type: 'text', text: 'Catalog printed\n' + tail + '\nEnd' }] } });
  }
  const rows = [{ type: 'message_end', message: { role: 'assistant', stopReason: stop,
   content: mode === 'no-text' ? [{ type: 'thinking', thinking: 'private thought' }] : [
    { type: 'thinking', thinking: 'never in final output' }, { type: 'text', text: `synthetic reply ${turn}\n\u2028\u2029😀` }],
   ...(mode === 'error' ? { errorMessage: 'structured synthetic failure; Authorization: Bearer synthetic-secret-value\n' + 'x'.repeat(3000) } : {}),
   usage: { input: 99999, output: 99999, cacheRead: 99999, cacheWrite: 99999 } } },
   { type: 'agent_end', willRetry: false }, ...(mode === 'agent-end-only' ? [] : [{ type: 'agent_settled', aborted: mode === 'abort' }])];
  if (mode === 'output-ledger') {
   const assistant = { type: 'message_start', message: { role: 'assistant' } };
   const failed = { type: 'message_end', message: { role: 'assistant', stopReason: 'error', usage: { output: 0 } } };
   const toolRequest = { type: 'message_end', message: { role: 'assistant', responseId: 'tool-response', stopReason: 'toolUse', usage: { output: 4 } } };
   rows.unshift(assistant, failed, assistant, toolRequest, assistant, toolRequest, assistant);
  }
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (mode === 'unicode') { for (let i = 0; i < bytes.length; i += 7) process.stdout.write(bytes.subarray(i, i + 7)); }
  else process.stdout.write(bytes);
  started = false; finishing = false; sent = [];
  if (mode === 'agent-end-only') setTimeout(() => process.exit(0), 10);
 };
 if (mode === 'retry') setTimeout(end, 25); else end();
}
function command(row) {
 note(row);
 const response = data => send({ id: row.id, type: 'response', command: row.type, success: true, data });
 if (row.type === 'get_state') {
  if (mode === 'missing') { process.exit(0); return; }
  response({ sessionId: id, sessionFile: file, model: { provider: model.slice(0, slash), id: model.slice(slash + 1) },
   thinkingLevel: args.includes('--thinking') && value('--thinking') !== 'off' ? value('--thinking') : 'low',
   isStreaming: mode === 'busy', isCompacting: false, pendingMessageCount: 0 });
  if (mode === 'backpressure' && !turn) { process.stdin.pause(); setTimeout(() => process.stdin.resume(), 100); }
 } else if (row.type === 'get_session_stats') {
  const n = (requested ? 2 : 1) * turn;
  response({ sessionId: id, sessionFile: file, tokens: { input: 10 * n + 3, cacheRead: 4 * n, cacheWrite: n, output: 2 * n + 5 } });
 } else if (row.type === 'prompt') {
  const wasStarted = started;
  if (!started) { started = true; turn++; send({ type: 'agent_start' }); }
  response({ disposition: mode === 'handled' ? 'handled' : wasStarted ? 'queued' : 'started' });
  if (mode === 'handled') { started = false; return; }
  if (mode === 'response-only') { setTimeout(() => process.exit(0), 10); return; }
  if (mode === 'extension') { send({ type: 'extension_ui_request', id: 'dialog', method: 'confirm', title: 'synthetic confirmation', message: 'never approve' }); return; }
  if (mode === 'cancel' && wasStarted) send({ type: 'queue_update', steering: [row.message], followUp: [] });
  else send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: mode === 'transform' ? 'changed by extension' : row.message }] } });
  sent.push(row.message);
  if (['hold', 'cancel', 'duplicate', 'descendant'].includes(mode)) {
   if (!wasStarted) {
    const timer = setInterval(() => { if (existsSync(process.env.PI_STUB_RELEASE)) { clearInterval(timer); finish(); } }, 10);
   }
  } else setImmediate(finish);
 } else if (row.type === 'compact') {
  if (mode === 'compact-fail') { send({ id: row.id, type: 'response', command: 'compact', success: false, error: 'Nothing to compact (session too small)' }); return; }
  send({ type: 'compaction_start', reason: 'manual' });
  const result = { summary: 'synthetic summary', firstKeptEntryId: 'entry-1', tokensBefore: 100, estimatedTokensAfter: 10 };
  send({ type: 'compaction_end', reason: 'manual', result, aborted: false, willRetry: false });
  response(result);
 } else if (row.type === 'extension_ui_response') note({ cancelled: row.cancelled, confirmed: row.confirmed });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) command(JSON.parse(line)); } });
process.stdin.on('end', () => {
 if (mode.startsWith('tail-')) {
  const tail = mode === 'tail-utf8' ? Buffer.from([0xf0, 0x9f]) : mode === 'tail-line' ? '{broken}\n' : '{"type":';
  process.stdout.write(tail, () => process.exit(0));
 } else if (mode !== 'descendant') process.exit(0);
});
