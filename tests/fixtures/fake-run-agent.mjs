import { createInterface } from 'node:readline';
/** Controlled local CLI: file gates, output formats, and one three-generation group. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
function arg(name) {
  const embedded = args.find(a => a.startsWith(`${name}=`));
  if (embedded) return embedded.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const root = arg('--root'), branch = arg('--branch'), leader = Number(arg('--leader') ?? process.pid);
if (!root || !realpathSync(root).startsWith(realpathSync(tmpdir()) + sep) || !basename(root).startsWith('alpacawork-'))
  throw new Error('Fake agent requires an isolated temporary alpacawork root');
mkdirSync(join(root, 'processes'), { recursive: true });
const receipt = join(root, 'processes', `${process.pid}.json`);
const save = extra => writeFileSync(receipt, JSON.stringify({ pid: process.pid, pgid: leader, branch: branch ?? 'agent', ...extra }));
if (branch) {
  if (arg('--stubborn') === 'yes' && branch === 'grandchild') process.on('SIGTERM', () => {
    writeFileSync(join(root, 'term-grandchild'), String(Date.now()));
  });
  save({ ready: true });
  if (branch === 'child') spawn(process.execPath, [import.meta.filename, '--root', root, '--branch', 'grandchild', '--leader', String(leader), '--stubborn', arg('--stubborn')], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
} else {
  let plan = {};
  const lines = createInterface({ input: process.stdin });
  const instruction = await new Promise(done => lines.once('line', line => done(JSON.parse(line))));
  const prompt = instruction.message?.content ?? instruction.text;
  try { plan = JSON.parse(prompt); } catch {
    // Formal Task requests contain the synthetic plan as the request body's own JSON line.
    const body = (prompt.split('\n## Request\n')[1]?.split('\n\n')[0] ?? prompt)
      .split('\n').find(line => line.startsWith('{'));
    if (body) { try { plan = JSON.parse(body); } catch {} }
  }
  const format = arg('--format'), session = arg('--session') ?? arg('--session-id') ?? arg('--resume') ?? (args.includes('resume') ? args.at(-1) : undefined) ?? plan.session ?? `fake-${process.pid}`;
  const result = arg('--result') ?? arg('-o');
  if (plan.group) spawn(process.execPath, [import.meta.filename, '--root', root, '--branch', 'child', '--leader', String(leader), '--stubborn', plan.stubborn ? 'yes' : 'no'], { stdio: 'ignore' });
  save({ ready: true, env: process.env, prompt, cwd: process.cwd() });
  const emit = value => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (plan.invalidUtf8 && value.type === 'result') bytes[bytes.indexOf('"result":"') + 10] = 0xff;
    process.stdout.write(bytes);
  };
  if (plan.receiveJoined && format === 'claude') {
    lines.on('line', line => {
      const input = JSON.parse(line);
      emit({ type: 'command_lifecycle', state: 'started', command_uuid: input.uuid });
    });
  } else lines.close();
  if (format === 'codex' && !plan.busy) {
    emit({ type: 'thread.started', thread_id: session });
    emit({ type: 'input.taken', id: instruction.id });
    if (plan.activity) emit({ type: 'item.started', item: { id: 'fake-tool', type: 'command_execution', command: plan.activityCommand ?? 'private' } });
  }
  if (format === 'claude') {
    emit({ type: 'system', subtype: 'init', session_id: session });
    emit({ type: 'command_lifecycle', state: 'started', command_uuid: instruction.uuid });
    if (plan.activity) emit({ type: 'assistant', parent_tool_use_id: null, timestamp: new Date().toISOString(), message: { content: [
      { type: 'tool_use', id: 'fake-tool', name: 'Bash', input: { command: plan.activityCommand ?? 'private' } }] } });
  }
  if (format !== 'claude' && format !== 'codex') emit({ type: 'input.taken', id: instruction.id });
  if (plan.gate) while (!existsSync(plan.gate)) await delay(20);
  if (plan.receiveJoined) lines.close();
  if (plan.sessionLimit && format === 'claude') {
    await new Promise(resolve => process.stdout.write(JSON.stringify({
      type: 'result', is_error: true, result: "You've hit your session limit · resets 5pm (Asia/Tokyo)", session_id: session,
    }) + '\n', resolve));
    process.exit(1);
  }
  if (plan.fallbackGate && format === 'codex') while (!existsSync(plan.fallbackGate)) await delay(20);
  if (plan.group) await new Promise(() => { setInterval(() => {}, 1000); });
  if (plan.busy) { process.stderr.write(`thread ${session} already has an active writer (code -32600)\n`); process.exit(1); }
  if (plan.exit) { process.stderr.write('fake failure\n'); process.exit(plan.exit); }
  // Images the agent read: one event per image, as long Runs record them before their final event.
  for (let written = 0; written < (plan.imageBytes ?? 0);) {
    const data = 'A'.repeat(1024 * 1024);
    const line = JSON.stringify(format === 'codex'
      ? { type: 'item.completed', item: { type: 'mcp_tool_call', result: { content: [{ type: 'image', data }] } } }
      : { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fake-image',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] } }) + '\n';
    process.stdout.write(line);
    written += Buffer.byteLength(line);
  }
  if (plan.brokenLine) process.stdout.write('{broken json\n');
  const cliResult = plan.cliTaskGet ? spawnSync(process.execPath,
    [plan.cliPath, 'task', 'get', '--task', plan.cliTaskGet], { encoding: 'utf8', timeout: 10_000 }) : null;
  const output = cliResult ? JSON.stringify({ code: cliResult.status, body: cliResult.stdout, error: cliResult.stderr,
    server: process.env.ALPACAWORK_SERVER })
    : plan.environment ? JSON.stringify(process.env) : plan.bytes ? 'x'.repeat(plan.bytes) : plan.output ?? 'fake result';
  if (format === 'claude') {
    if (plan.activity) emit({ type: 'user', timestamp: new Date().toISOString(), message: { content: [
      { type: 'tool_result', tool_use_id: 'fake-tool', content: 'private' }] } });
    emit({ type: 'result', is_error: plan.isError ?? false, result: output,
      session_id: plan.mismatch ? 'wrong-session' : session,
      ...(plan.usage ? { modelUsage: { fake: plan.usage } } : {}) });
    emit({ type: 'system', subtype: 'task_summary', session_id: session });
  }
  else if (format === 'codex' && plan.activity) emit({ type: 'item.completed', item: { id: 'fake-tool', type: 'command_execution', output: 'private' } });
  if (format === 'codex') emit({ type: 'turn.completed', ...(plan.usage ? { usage: plan.usage.scope ? plan.usage : { scope: 'conversation', counters: { input: plan.usage.input_tokens - (plan.usage.cached_input_tokens ?? 0) - (plan.usage.cache_write_input_tokens ?? 0), cacheRead: plan.usage.cached_input_tokens ?? 0, cacheWrite: plan.usage.cache_write_input_tokens ?? 0, output: plan.usage.output_tokens } } } : {}) });
  else if (format !== 'codex' && format !== 'claude' && !plan.resultOnly) process.stdout.write(output);
  if (result && !plan.noResult) writeFileSync(result, plan.invalidUtf8 ? Buffer.from([0xff]) : output, { mode: 0o600 });
  if (plan.afterResultGate) while (!existsSync(plan.afterResultGate)) await delay(20);
  if (plan.exitAfterResult) process.exit(plan.exitAfterResult);
}
