import { createInterface } from 'node:readline';
/**
 * The e2e coordinator: it carries out what the user said on the screen with the alpacawork CLI, as the coordinator's
 * instructions say, and answers with the command it ran and what came of it ({command, ok, output}).
 * - A press (the message's screen-action JSON line) becomes a normal instruction using current write guards;
 *   the original words remain its quote and body.
 * - Explicit choice-answer fixtures save each original question by its identity (--answers).
 * - 'Revise this result' explicitly asks this fixture to send a submitted review back through task request.
 * - Other words about a Task (the screen's, else the first Task ID in them) answer its open question to the user, if any.
 * - Anything else, the warm-up too, it only answers ({command: null}).
 * Like a coordinator Run it has no Run credential: it calls with the server alone (ALPACAWORK_SERVER), as the
 * conversation it answers in (its assigned session).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { awaitsReview } from '@alpacawork/contract';
import { remoteFixture } from '../fixture-writes.ts';
import { coordinatorAnswersInputSchema, coordinatorIntentSchema } from '@alpacawork/contract/coordinator';

const launch = process.argv.slice(2);
const arg = name => { const at = launch.indexOf(name); return at < 0 ? undefined : launch[at + 1]; };
const mode = launch.includes('--resume') ? 'resume' : 'start';
const session = arg('--session-id') ?? arg('--resume');
const args = [arg('--model'), arg('--effort')].filter(value => value !== undefined);
const input = createInterface({ input: process.stdin });
const first = await new Promise(done => input.once('line', line => done(JSON.parse(line))));
input.close();
const prompt = first.message.content;
process.stdout.write(JSON.stringify({ type: 'command_lifecycle', state: 'started', command_uuid: first.uuid, session_id: session }) + '\n');
// Without its server the CLI would fall back to a saved or default one, outside this workspace.
if (!process.env.ALPACAWORK_SERVER) throw new Error('A coordinator Run is given ALPACAWORK_SERVER');
const cli = new URL('../../apps/cli/dist/cli.js', import.meta.url).pathname;
/** Enough of a Task's log to find where its hold was taken from. */
const LOG_ENTRIES = '1000';

/**
 * The message as serve wrote it: the screen's Task, the user's words, the press, the questions they answer; then the
 * files.
 */
function read(text) {
  const lines = text.split('\n');
  const sourceRequest = /Request ID of this input: ([0-9a-f-]+)\b/.exec(lines[0])?.[1];
  if (sourceRequest) lines.shift();
  const context = /^（画面で (\S+) を開いています）$/.exec(lines[0])?.[1] ?? null;
  if (context !== null) lines.shift();
  while (lines.length && /^!\[[^\]]*\]\([^)]*\)$/.test(lines.at(-1))) lines.pop();
  const answers = /^Questions being answered: (\[.*\])$/.exec(lines.at(-1) ?? '');
  if (answers) lines.pop();
  const press = /^Screen action: (\{.*\})$/.exec(lines.at(-1) ?? '');
  if (press) lines.pop();
  return { context, sourceRequest, words: lines.join('\n'), intent: press ? coordinatorIntentSchema.parse(JSON.parse(press[1])) : null,
    answers: answers ? coordinatorAnswersInputSchema.parse(JSON.parse(answers[1])) : [] };
}
const parsed = text => { try { return JSON.parse(text); } catch { return text; } };
/**
 * One alpacawork command as this conversation; a write carries one operation ID.
 */
async function alpacawork(args, { write = false, input } = {}) {
  const argv = write ? [...args, '--op-id', randomUUID(), ...(message.sourceRequest ? ['--source-request', message.sourceRequest] : [])] : args;
  const result = spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session } });
  const ok = result.status === 0, output = parsed(ok ? result.stdout : result.stderr);
  return { command: args, ok, output };
}

const versions = intent => [
  ...intent.expectedTaskHash === undefined ? [] : ['--expected-task-hash', intent.expectedTaskHash],
  ...intent.expectedPlacementRevision == null ? [] : ['--expected-placement-revision', String(intent.expectedPlacementRevision)]];
const report = (intent, state, words, more = []) => alpacawork(['task', 'report', '--task', intent.task, '--state', state,
  ...more, `--quote=${words}`, ...versions(intent)], { write: true });
const request = (intent, words, more = []) => alpacawork(['task', 'request', '--task', intent.task, ...more,
  '--instruction-file', '-', `--quote=${words}`, ...versions(intent)], { write: true, input: words });

/** A press, carried out with the versions it carries. */
async function carryOut(intent, words) {
  switch (intent.action) {
    case 'sendback': case 'continue': case 'retry': {
      const shown = await alpacawork(['task', 'get', '--task', intent.task]);
      if (!shown.ok) return shown;
      const responsible = shown.output.agents.find(each => each.active && each.responsible);
      return request({ task: intent.task, expectedTaskHash: shown.output.task.hash, expectedPlacementRevision: responsible?.revision }, words);
    }
  }
}
/** A draft's choices: each question listed is answered by its ID as it is, never one read now; one outcome for each. */
async function answerEach(answers, words) {
  const outcomes = [];
  for (const reference of answers) outcomes.push(await request(reference, words, ['--answers', reference.question]));
  return outcomes.length === 1 ? outcomes[0] : outcomes;
}
/** An explicit fixture revision instruction, else the answer to the Task's oldest open question to the user. */
async function answer(context, words) {
  const confirmation = /confirm-review:(\{.*\})/m.exec(words);
  if (confirmation) { const target = JSON.parse(confirmation[1]); return report(target, 'done', words, target.aboutRun ? ['--about-run', target.aboutRun] : []); }
  const task = context ?? /\bT\d+\b/.exec(words)?.[0];
  if (task === undefined) return { command: null };
  const shown = await alpacawork(['task', 'get', '--task', task, '--log', LOG_ENTRIES]);
  // An explicit test instruction stands for the coordinator's interpretation of a user's revision request.
  if (shown.ok && words.startsWith('Revise this result') && awaitsReview(shown.output.task)) {
    const responsible = shown.output.agents.find(each => each.active && each.responsible);
    return request({ task, expectedTaskHash: shown.output.task.hash,
      expectedPlacementRevision: responsible?.revision }, words, ['--new-conversation']);
  }
  const question = shown.ok ? shown.output.questions.find(item => item.destination.kind === 'user' && item.state === 'open') : undefined;
  const responsible = shown.ok ? shown.output.agents.find(each => each.active && each.responsible) : undefined;
  return question ? request({ task }, words, ['--answers', question.id]) : { command: null };
}

const message = read(prompt);
const modeFile = join(process.env.ALPACAWORK_WORKSPACE, 'coordinator-refusal-mode');
const refusalMode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : null;
if (refusalMode === 'unknown' && (message.intent || message.words.includes('confirm-review:'))) remoteFixture(process.env.ALPACAWORK_WORKSPACE, { kind: 'failReviewWrite' });
// An isolated test can force a real CLI write refusal while the agent itself replies normally.
const refuseWrite = existsSync(join(process.env.ALPACAWORK_WORKSPACE, 'refuse-coordinator-write'));
const withdraw = refuseWrite && readFileSync(join(process.env.ALPACAWORK_WORKSPACE, 'refuse-coordinator-write'), 'utf8').trim() === 'withdraw';
const target = message.context ?? /\bT\d+\b/.exec(message.words)?.[0];
const outcome = refusalMode === 'forbidden' && (message.intent || message.words.includes('confirm-review:')) ? await report(message.intent ?? JSON.parse(/confirm-review:(\{.*\})/m.exec(message.words)[1]), 'doing', message.words)
  : withdraw ? await (async () => {
    const shown = await alpacawork(['task', 'get', '--task', target]);
    return alpacawork(['task', 'report', '--task', target, '--withdraw', shown.output.questions.find(q => q.state === 'open').id,
      '--expected-task-hash', shown.output.task.hash], { write: true });
  })()
  : refuseWrite ? await report({ task: target, expectedTaskHash: '0'.repeat(64) }, 'stopped', message.words)
  : message.intent ? await carryOut(message.intent, message.words)
  : message.answers.length ? await answerEach(message.answers, message.words) : await answer(message.context, message.words);
process.stdout.write(JSON.stringify({ type: 'result', session_id: session, is_error: false, result: refuseWrite ? '処理を終えました。' : JSON.stringify(outcome) }) + '\n');
