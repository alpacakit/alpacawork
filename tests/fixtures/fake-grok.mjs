#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const session = value(args.includes('--resume') ? '--resume' : '--session-id');
const promptFile = value('--prompt-file');
const prompt = readFileSync(promptFile, 'utf8');
appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify({ args, prompt, session, promptFile }) + '\n');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'available_commands', tools: [], commands: [] });
if (prompt === 'auth') { emit({ type: 'error', message: 'Not signed in. Run grok login or set XAI_API_KEY.' }); process.exit(1); }
if (prompt === 'preempt' || prompt === 'hold') {
  while (!existsSync(process.env.FAKE_GROK_RELEASE)) await delay(10);
}
if (prompt === 'malformed') { process.stdout.write('{broken\n'); process.exit(0); }
emit({ type: 'thought', data: 'working' });
if (prompt === 'interrupt') {
  writeFileSync(process.env.FAKE_GROK_READY, '');
  await delay(60000);
}
emit({ type: 'tool_call', toolCallId: 'x1', toolName: 'x_search' });
emit({ type: 'text', data: `answer ${prompt}` });
if (prompt === 'disconnect') process.exit(1);
if (prompt === 'no-end') process.exit(0);
if (prompt === 'truncated') { process.stdout.write('{'); process.exit(0); }
emit({ type: 'end', stopReason: prompt === 'refused' ? 'refusal' : 'end_turn',
  sessionId: prompt === 'wrong-session' ? 'wrong' : session, usage: { input_tokens: 1, output_tokens: 2 } });
if (prompt === 'after-end') emit({ type: 'text', data: 'late' });
process.exit(prompt === 'false-success' ? 1 : 0);
