// Last-resort lifetime for this test-owned process; normal cleanup closes it first.
setTimeout(() => process.exit(124), 150000).unref();
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
/** Isolated coordinator agent: reports its launch and reads attached images from their absolute paths. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// Arguments after the prompt (a config's {model} and {effort}) are reported back as `args`.
const launch = process.argv.slice(2);
const arg = name => { const at = launch.indexOf(name); return at < 0 ? undefined : launch[at + 1]; };
const bridge = launch.includes('--fixture-bridge');
const mode = launch.includes('--resume') || launch.includes('resume') ? 'resume' : 'start';
const session = bridge ? (mode === 'resume' ? launch.at(-1) : randomUUID()) : arg('--session-id') ?? arg('--resume');
const effort = launch.find(value => value.startsWith('model_reasoning_effort='))?.split('=')[1];
const args = [arg(bridge ? '-m' : '--model'), bridge ? effort : arg('--effort')].filter(value => value !== undefined);
const emit = value => {
  if (bridge && value.type === 'result') {
    if (!value.is_error) writeFileSync(arg('-o'), value.result);
    process.stdout.write(JSON.stringify({ type: value.is_error ? 'turn.failed' : 'turn.completed' }) + '\n');
  } else process.stdout.write(JSON.stringify(value) + '\n');
};
const input = createInterface({ input: process.stdin });
const first = await new Promise(done => input.once('line', line => done(JSON.parse(line))));
input.close();
const prompt = bridge ? first.text : first.message.content;
if (bridge) { emit({ type: 'thread.started', thread_id: session }); emit({ type: 'input.taken', id: first.id }); }
else emit({ type: 'command_lifecycle', state: 'started', command_uuid: first.uuid, session_id: session });
// Control commands belong to the message, before any initial conversation instructions.
const message = prompt.split(/^Request ID of this input: [^\n]+\n/m).at(-1);
// A test leaves its marks in the workspace's coordinator folder; the agent works in its own empty folder below it.
const marks = join(process.env.ALPACAWORK_WORKSPACE, '.alpacawork', 'coordinator');
const failureRepaired = existsSync(join(marks, '.failure-repaired'));
if (!failureRepaired && ['fail-weekly', 'fail-general'].includes(message)) {
  const detail = message === 'fail-weekly' ? "You've hit your weekly limit · resets Nov 8, 8pm (Asia/Tokyo)"
    : 'Service unavailable. token=sk-syntheticSecret123456';
  emit({ type: 'result', session_id: session, is_error: true, result: detail });
  process.exit(1);
}
if (message === 'fail-exit') process.exit(2);
if (message === 'fail-output') process.exit(0);
const usage = /^usage:(\d+)$/.exec(message);
if (usage && !bridge) emit({ type: 'assistant', parent_tool_use_id: null, message: {
  content: [{ type: 'text', text: 'Working' }],
  usage: { input_tokens: Number(usage[1]), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
} });
const busyOnce = join(marks, '.busy-once');
if (mode === 'resume' && message === 'busy-once' && !existsSync(busyOnce)) {
  writeFileSync(busyOnce, 'busy');
  process.stderr.write('already has an active writer');
  process.exit(1);
}
// A background child left in the agent's process group, which outlives the agent itself.
if (message.startsWith('child:')) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }).unref();
const gate = /^(?:wait|child):([^\n]+)(?:\n|$)/.exec(message)?.[1];
// Test setup waits for this process to read its input, rather than a later DB receipt import.
const requestId = /^Request ID of this input: ([^.\n]+)/m.exec(prompt)?.[1];
// A coordinator can use the real CLI as its first action, before a warm-up or model latency.
if (bridge && /^create-immediately:P\d+$/.test(message)) {
  const cli = new URL('../../apps/cli/dist/cli.js', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli, '--server', process.env.ALPACAWORK_SERVER, 'task', 'new', '--from-user',
    '--parent', message.slice('create-immediately:'.length), '--title', 'Cold-start task', '--op-id', randomUUID(),
    '--source-request', requestId], { env: { ...process.env, CODEX_THREAD_ID: session }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  emit({ type: 'result', session_id: session, is_error: false, result: JSON.stringify({ code, stdout, stderr }) });
  process.exit(0);
}
if (gate && requestId) {
  const started = join(marks, 'agent-' + encodeURIComponent(requestId) + '.json'), temporary = started + '.' + process.pid;
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, session }));
  renameSync(temporary, started);
}
if (gate) while (!existsSync(gate)) await delay(20);
// Return the exact Markdown produced by a test agent, through the real completion receiver: a file it names, or the
// workspace's answer.md (the agent works in its own empty folder) for the sample request, whatever the screen showed.
if (message.startsWith('answer-from:') || message.split('\n').includes('Show the attached sample.')) {
  emit({ type: 'result', session_id: session, is_error: false,
    result: readFileSync(message.startsWith('answer-from:') ? message.split('\n')[0].slice('answer-from:'.length) : join(process.env.ALPACAWORK_WORKSPACE, 'answer.md'), 'utf8') });
  process.exit(0);
}
// A Markdown answer naming a task and holding code, for what the answer draws.
if (message.includes('markdown-answer')) {
  emit({ type: 'result', session_id: session, is_error: false,
    result: 'Please see **T11**.\n\n```\npnpm build\n```' });
  process.exit(0);
}
// Code of three lengths: a short one, one long line and several lines.
if (message.includes('code-answer')) {
  emit({ type: 'result', session_id: session, is_error: false,
    result: 'Run the following to try it.\n\n```\npnpm build\n```\n\nA long line:\n\n```\nalpacawork task report --task T139 --state waiting --ask-to user --title "Please check the sample" --description-file - --expected-task-hash a4265667c32eafd5e21e4f682525a8f2e3f07900463c643637fe32cb108fc059\n```\n\nExample configuration:\n\n```\ncodex:\n  model:\n    choices: [ gpt-6.1-sol ]\n    default: gpt-6.1-sol\n```' });
  process.exit(0);
}
// An answer of the shapes a reply carries: lists, inline code, a quote, a long URL, a long code line and a table, and
// words with no place to fold: a heading of code, a path in code inside strong words, a call in code
// and a task reference of a long label.
if (message.includes('wide-answer')) {
  emit({ type: 'result', session_id: session, is_error: false,
    result: '- The current main head is 1a2b3c4d. It matches the version deployed a moment ago, around 13:28.\n- Production is running this version and the previous deployment finished successfully.\n  - In an indented item, write `pnpm test:all`.\n\n1. Numbered item\n2. Next item\n\n> Quoted line\n\nhttps://example.com/' + 'a'.repeat(80) + '\n\n```\n' + 'x'.repeat(200) + '\n```\n\n| Column | Column | Column |\n|---|---|---|\n| ' + 'Cell'.repeat(30) + ' | b | c |\n\n## `apps/web/src/features/coordinator/CoordinatorThread.tsx`\n\n**今の作り**（`apps/web/src/features/forms/ReportInputs.tsx`）\n\n- 送ると `sendIntent(intentAbout(task,choice,people),undefined,titleAndBody)` が呼ばれます。\n- [ReportInputs の入力欄を一つにまとめる作業の続きを確かめるための参照](T11)' });
  process.exit(0);
}
const images = [...prompt.matchAll(/!\[([^\]]+)\]\(([^)]+)\)/g)];
const attachmentBytes = Object.fromEntries(images.map(match => [match[1], readFileSync(match[2]).length]));
const image = images.find(match => /\.(png|jpe?g|webp)$/i.test(match[1]));
const imageBytes = image ? attachmentBytes[image[1]] : 0;
emit({ type: 'result', session_id: session, is_error: false,
  result: JSON.stringify({ mode, session, prompt, args, imageBytes, attachmentBytes, run: process.env.ALPACAWORK_RUN ?? null,
    workspace: process.env.ALPACAWORK_WORKSPACE, cwd: process.cwd() }) });
