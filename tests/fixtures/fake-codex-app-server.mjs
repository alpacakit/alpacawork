/**
 * Stand-in for `codex app-server` over stdio for alpacawork-agent tests. It logs its argv and every request
 * to FAKE_CODEX_LOG. A turn's first input text is a JSON plan: it ends when the file `gate` exists (at
 * once without one) and fails when `fail` is set. With `child`, a sub-agent thread runs a whole turn of its own
 * first, as Codex's spawn_agent does, and the fake logs `{ child: 'done' }` after it. A steer whose text contains
 * "refuse", or one without an active turn, is an error. Every notification names its thread, as app-server does.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const log = value => appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(value)}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
log({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME, sqliteHome: process.env.CODEX_SQLITE_HOME });
let thread = null, turn = null, turns = 0;
if (process.env.FAKE_CODEX_TERM_DELAY_MS) process.on('SIGTERM', () => {
  log({ term: true }); setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_TERM_DELAY_MS));
});
const notify = (method, params, threadId = thread) => send({ method, params: { threadId, ...params } });
const user = (id, text) => notify('item/started', { item: { type: 'userMessage', id: `u-${id}`, clientId: id, content: [{ type: 'text', text }] } });
async function run(id, plan) {
  if (plan.child) {
    const child = 'thread-child', childTurn = `child-${id}`;
    notify('turn/started', { turn: { id: childTurn } }, child);
    notify('item/completed', { item: { type: 'agentMessage', id: `m-${childTurn}`, text: 'child reply', phase: 'final_answer' } }, child);
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 999, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 9, reasoningOutputTokens: 0 } } }, child);
    notify('turn/completed', { turn: { id: childTurn, status: 'completed' } }, child);
    log({ child: 'done' });
  }
  while (plan.gate && !existsSync(plan.gate)) await delay(20);
  notify('item/started', { item: { type: 'commandExecution', id: `c-${id}`, command: 'true' } });
  notify('item/completed', { item: { type: 'agentMessage', id: `m-${id}`, text: `reply ${id}`, phase: 'final_answer' } });
  if (!plan.noUsage) notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10 * turns, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 0 } } });
  notify('turn/completed', { turn: plan.fail ? { id, status: 'failed', error: { message: 'fake failure' } } : { id, status: 'completed' } });
  turn = null;
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log(message);
  const { id, method, params } = message;
  const reply = result => send({ id, result });
  if (method === 'initialize') {
    // Holds this start at a point the test chooses.
    const gate = process.env.FAKE_CODEX_INITIALIZE_GATE;
    if (gate) void (async () => {
      while (!existsSync(gate)) await delay(10);
      if (process.env.FAKE_CODEX_INITIALIZE_EXIT) process.exit(20);
      reply({});
    })();
    else reply({});
  }
  else if (method === 'config/read') reply({ config: JSON.parse(process.env.FAKE_CODEX_CONFIG ?? '{}') });
  else if (method === 'account/read') reply({ account: process.env.FAKE_CODEX_NO_ACCOUNT ? null : { type: 'chatgpt' } });
  else if (method === 'thread/start') { thread = 'thread-new'; reply({ thread: { id: thread } }); }
  else if (method === 'thread/resume') { thread = params.threadId; reply({ thread: { id: thread } }); }
  else if (method === 'turn/start') {
    let fault = {}; try { fault = JSON.parse(params.input[0].text); } catch {}
    log({ processedInput: params.clientUserMessageId });
    if (fault.disconnect_before_reply) { process.exit(17); return; }
    if (fault.error_then_exit) { send({ id, error: { message: 'provider rejected after transfer' } }); setTimeout(() => process.exit(18), 10); return; }
    turns++;
    turn = `turn-${turns}`;
    if (fault.delayed_taken) send({ id, error: { message: 'response was uncertain' } });
    else reply({ turn: { id: turn } });
    notify('turn/started', { turn: { id: turn } });
    if (fault.delayed_taken) setTimeout(() => user(params.clientUserMessageId, params.input[0].text), 75);
    else if (!fault.no_receipt) user(params.clientUserMessageId, params.input[0].text);
    let plan = {};
    try { plan = JSON.parse(params.input[0].text); } catch { /* plain text */ }
    void run(turn, plan);
  } else if (method === 'turn/steer') {
    let fault = {}; try { fault = JSON.parse(params.input[0].text); } catch {}
    log({ processedInput: params.clientUserMessageId });
    if (fault.disconnect_before_reply) { process.exit(17); return; }
    if (fault.error_then_exit) { send({ id, error: { message: 'provider rejected after transfer' } }); setTimeout(() => process.exit(18), 10); return; }
    if (fault.delayed_taken) { send({ id, error: { message: 'response was uncertain' } }); setTimeout(() => user(params.clientUserMessageId, params.input[0].text), 75); return; }
    if (!turn || params.expectedTurnId !== turn || params.input[0].text.includes('refuse'))
      send({ id, error: { code: -32600, message: turn ? 'steer refused' : 'no active turn to steer' } });
    else { reply({ turnId: turn }); user(params.clientUserMessageId, params.input[0].text); }
  }
});
