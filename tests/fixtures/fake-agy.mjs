#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AGY_ARGS, `${JSON.stringify(args)}\n`);
if (args[0] !== '--input-format' || args[1] !== 'stream-json' ||
  args[2] !== '--output-format' || args[3] !== 'stream-json' ||
  args[4] !== '--dangerously-skip-permissions' || args.includes('--prompt')) process.exit(2);
const resume = args.indexOf('--conversation');
if (resume !== -1 && args[resume + 1] !== 'A-parent') process.exit(2);
const model = args.indexOf('--model');
if (model !== -1 && args[model + 1] !== (process.env.FAKE_AGY_MODEL ?? 'test-model')) process.exit(2);
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
if (!stdin.endsWith('\n') || stdin.trim().split('\n').length !== 1) process.exit(2);
const input = JSON.parse(stdin);
if (input.event !== 'user' || typeof input.message?.content !== 'string') process.exit(2);
const prompt = input.message.content;
appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(prompt)}\n`);
const write = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const step = (step_type, extra = {}) => write({ event: 'step_update', step_update: {
  conversation_id: 'A-parent', step_index: 1, state: 'DONE', step_type, ...extra } });
const result = (extra = {}) => write({ event: 'result', result: {
  conversation_id: 'A-parent', status: 'SUCCESS', response: `answer ${prompt}`,
  usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, ...extra } });
if (prompt === 'auth') {
  process.stderr.write('authentication required; run agy interactively to sign in\n');
  process.exit(1);
}
if (prompt === 'early-error') {
  result({ status: 'ERROR', response: '', error: 'session unavailable' });
  process.exit(1);
}
if (prompt === 'result-without-init') { result(); process.exit(0); }
write({ event: 'init', conversation_id: prompt === 'wrong-session' ? 'A-other' : 'A-parent',
  init: { cwd: process.cwd(), tools: ['read_file'], permission_mode: 'always-proceed' } });
if (prompt === 'disconnect') process.exit(7);
if (prompt === 'malformed') { process.stdout.write('not-json\n'); process.exit(0); }
if (prompt === 'truncated') { process.stdout.write('{"event":'); process.exit(0); }
if (prompt === 'no-result') process.exit(0);
if (prompt === 'invalid-step') { step('user_input', { state: 'INVALID' }); process.exit(0); }
if (prompt === 'step-without-session') { step('user_input', { conversation_id: undefined }); process.exit(0); }
if (prompt === 'unknown-event') { write({ event: 'not-real' }); process.exit(0); }
if (prompt === 'hold' || prompt === 'preempt' || prompt === 'checkpoint') {
  if (prompt === 'checkpoint') step('checkpoint');
  const timer = setInterval(() => {
    if (!existsSync(process.env.FAKE_AGY_RELEASE)) return;
    clearInterval(timer);
    finish();
  }, 10);
} else finish();

function finish() {
  if (prompt === 'tool-only') {
    step('tool', { state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { path: 'test.txt' } } });
    step('tool', { tool_name: 'read_file', tool_info: { output: 'not found', error: { type: 'Error', message: 'not found' } } });
  } else if (prompt === 'assistant-only') {
    step('agent_response', { state: 'ACTIVE', text_delta: 'partial answer' });
    step('agent_response', { text_delta: ' done' });
  } else if (prompt !== 'completion-only') {
    step('user_input');
    step('agent_response', { state: 'ACTIVE', text_delta: 'partial ' });
    step('agent_response', { text_delta: `output ${prompt}` });
  }
  if (prompt === 'event-wrong-session') step('agent_response', { conversation_id: 'A-other', text_delta: 'other session' });
  if (prompt === 'result-wrong-session') { result({ conversation_id: 'A-other' }); return; }
  if (prompt === 'missing-response') { result({ response: undefined }); return; }
  if (prompt === 'invalid-result') { result({ status: null }); return; }
  if (prompt === 'error') result({ status: 'ERROR', response: '', error: 'model failed' });
  else if (prompt === 'cancelled') result({ status: 'CANCELLED', response: '', error: 'cancelled by user' });
  else if (prompt === 'contradictory-success') result({ error: 'response failed' });
  else result();
  if (prompt === 'duplicate-result') result();
  if (prompt === 'false-success') process.exitCode = 7;
}
