/** A deterministic actor for the disposable preview, never part of the published distribution. All task changes use the real CLI. */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { coordinatorInput } from './scenario.mjs';
const root = dirname(process.env.HOME ?? '');
if (!/^\/tmp\/alpacawork-first-run-[A-Za-z0-9]+$/.test(root)) throw new Error('Preview actor requires its disposable HOME');
const marker = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8'));
if (marker.home !== process.env.HOME || marker.root !== root) throw new Error('Preview actor ownership mismatch');
const args = process.argv.slice(2), output = args[args.indexOf('-o') + 1];
// Availability probes never reach a real provider.
if (args.includes('--version')) { console.log('Synthetic preview bridge'); process.exit(0); }
if (args.includes('--auth-status')) process.exit(1);
if (!output || !process.env.ALPACAWORK_RUN_CLI || !process.env.ALPACAWORK_SERVER) throw new Error('Expected a real preview launch');
const server = new URL(process.env.ALPACAWORK_SERVER);
if (server.hostname !== '127.0.0.1' || server.port === '5499' || process.env.ALPACAWORK_WORKSPACE !== join(marker.home, 'alpacawork')) throw new Error('Preview launch escaped isolation');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const input = createInterface({ input: process.stdin });
const first = await new Promise(done => input.once('line', line => done(JSON.parse(line)))); input.close();
const prompt = first.text;
const session = args.includes('resume') ? args.at(-1) : randomUUID();
emit({ type: 'thread.started', thread_id: session });
// Coordinators call as the conversation they speak for; task owners retain their real Run credential.
if (!process.env.ALPACAWORK_RUN) process.env.CODEX_THREAD_ID = session;
emit({ type: 'input.taken', id: first.id });
const ja = marker.language !== 'en';
const words = (j, e) => ja ? j : e;
// The examples that end in a choice: what the stand-in asks, and what its result says once the person has chosen.
const pair = ([j, e]) => words(j, e);
const asks = {
  models: { title: ['スネークゲームを選んでください', 'Choose a snake game'], question: ['どのスネークゲームにしますか？', 'Which snake game would you like?'],
    columns: ['| 候補 | 特徴 |', '| Candidate | What it is like |'],
    note: ['これは代役 AI による練習です。3つとも作ったことにしています。', 'This is a synthetic AI preview. It treats all 3 as built.'],
    options: [
      { name: ['黒い盤面', 'Plain board'], detail: ['黒い盤面に緑のヘビだけの、いちばん短い作りです。', 'The shortest build: a green snake on a black board.'], recommended: ['読まずに遊び始められるため。', 'You can start playing without reading anything.'] },
      { name: ['再開ボタンつき', 'Restart button'], detail: ['ゲームオーバーの後に押せる再開ボタンがあります。', 'Has a button to start again after game over.'] },
      { name: ['方眼つき', 'Grid lines'], detail: ['盤面に方眼があり、遊び方の説明が付きます。', 'Draws a grid on the board and explains how to play.'] }],
    result: chosen => words(`スネークゲームは「${chosen}」に決まりました。`, `The snake game is settled: “${chosen}”.`) },
  decide: { title: ['作るミニゲームを選んでください', 'Choose a mini game to build'], question: ['どのミニゲームを作りますか？', 'Which mini game shall I build?'],
    columns: ['| 案 | 遊び方 |', '| Idea | How it plays |'],
    note: ['これは代役 AI による練習です。選んだ後に、作ったことにして報告します。', 'This is a synthetic AI preview. After your choice, it reports the game as built.'],
    options: [
      { name: ['神経衰弱', 'Memory match'], detail: ['同じ絵のカードを2枚ずつめくってそろえます。', 'Turn over cards two at a time to find the pairs.'], recommended: ['1回が短く、すぐ遊べるため。', 'A round is short, so you can play right away.'] },
      { name: ['もぐらたたき', 'Whack-a-mole'], detail: ['出てきたもぐらを時間内にたたきます。', 'Hit the moles that pop up before time runs out.'] },
      { name: ['15パズル', 'Sliding puzzle'], detail: ['数字のこまを動かして順に並べます。', 'Slide the numbered tiles into order.'] }],
    result: chosen => words(`ミニゲーム「${chosen}」を作りました。`, `Built the mini game “${chosen}”.`) },
};
const files = join(root, 'actor-files'); mkdirSync(files, { recursive: true, mode: 0o700 });
let serial = 0;
const file = value => { const path = join(files, `${process.pid}-${serial++}`); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
function saveState(id, state) {
  const temporary = join(files, `${id}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(state)); renameSync(temporary, join(files, `${id}.json`));
}
const message = coordinatorInput(prompt), source = message?.source;
function cli(...argv) {
  const result = spawnSync(process.execPath, ['--import', join(root, 'network.mjs'), process.env.ALPACAWORK_RUN_CLI, ...argv, ...(source ? ['--source-request', source] : [])],
    { encoding: 'utf8', env: process.env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  // Read commands have no --source-request option.
  if (result.status !== 0) throw new Error(`${argv.slice(0, 3).join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function read(...argv) {
  const result = spawnSync(process.execPath, ['--import', join(root, 'network.mjs'), process.env.ALPACAWORK_RUN_CLI, ...argv], { encoding: 'utf8', env: process.env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${argv.join(' ')}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}
const task = id => read('task', 'get', '--task', id);
function request(id, text, question) {
  if (question) return cli('task', 'request', '--task', id, '--answers', question, '--instruction-file', file(text));
  const snapshot = task(id), owner = snapshot.agents.find(agent => agent.responsible && agent.active);
  return cli('task', 'request', '--task', id, '--expected-task-hash', snapshot.task.hash,
    '--expected-placement-revision', String(owner.revision), ...(owner.headRunId ? ['--expected-head-run', owner.headRunId] : []), '--instruction-file', file(text));
}
try {
  let reply;
  if (prompt.includes('Load the alpacawork skill and its coordinator reference, and do nothing else. Reply only with: ready')) reply = 'ready';
  else if (source) {
    const { answers, intent, body } = message;
    const referenced = /\bT\d+\b/.exec(body)?.[0];
    if (answers) {
      for (const answer of answers) {
        const path = join(files, `${answer.task}.json`), state = JSON.parse(readFileSync(path, 'utf8'));
        // The answer names its choice by the first word of the choice's name.
        state.choice = Math.max(0, asks[state.example].options.findIndex(option => option.name.some(name => body.includes(name.split(' ')[0]))));
        saveState(answer.task, state); request(answer.task, body, answer.question);
      }
      reply = words('答えを担当に伝えました。', 'I passed your choice to the owner.');
    } else if (intent) {
      request(intent.task, body);
      reply = words('直しを担当に頼みました。少しお待ちください。', 'I asked the owner to revise the result. Please wait a moment.');
    } else if (referenced) {
      const snapshot = task(referenced);
      const question = snapshot.questions.find(question => question.state === 'open' && question.destination.kind === 'user');
      request(referenced, body, question?.id);
      reply = words('担当に伝えました。もう一度結果を出します。', 'I passed your request to the owner, who will return another result.');
    } else {
      // Only the welcome's examples are scripted; anything else gets a plain reply, so the preview never makes up work.
      const example = marker.examples.find(each => body.includes(each.words));
      if (!example) reply = words('試用の代役 AI です。決まった動きしかできないため、ようこその画面にある例にだけタスクを作って答えます。',
        'This is the preview\'s stand-in AI. It can only follow a script, so it makes tasks only for the examples on the welcome screen.');
      else {
        const project = /\bP\d+\b/.exec(body)?.[0] ?? marker.project;
        if (!project) throw new Error('Preview project is not ready');
        const question = example.name in asks;
        const created = cli('task', 'new', '--from-user', '--parent', project, '--title', example.label);
        const id = created.task.id;
        saveState(id, { example: example.name, question, answered: false, revision: 0 });
        cli('agent', 'assign', '--task', id, '--role', 'responsible', '--profile', 'codex', '--expected-task-hash', created.task.hash);
        request(id, words('試用の依頼です。記録を使って進めてください。', 'This is a preview request. Continue through real task records.'));
        reply = words(`${id}「${example.label}」を作り、Codex に任せました。`, `I created ${id}, “${example.label}”, and assigned Codex.`);
      }
    }
  } else {
    const id = /^\[alpacawork\] Request for task (T\d+)/m.exec(prompt)?.[1];
    if (!id) throw new Error('Preview task prompt did not name a Task');
    const path = join(files, `${id}.json`), state = JSON.parse(readFileSync(path, 'utf8'));
    await delay(marker.exampleDelayMs);
    const current = task(id);
    if (state.question && !state.answered) {
      state.answered = true; saveState(id, state);
      const ask = asks[state.example];
      const decide = [{ decide_question: pair(ask.question), decide_note: pair(ask.note),
        decide_choices: ask.options.map(option => ({ decide_choice: pair(option.name), decide_choice_detail: pair(option.detail),
          ...(option.recommended ? { decide_choice_recommended: pair(option.recommended) } : {}) })) }];
      cli('task', 'report', '--task', id, '--state', 'waiting', '--ask-to', 'user', '--expected-task-hash', current.task.hash,
        '--title', pair(ask.title), '--description-file', file([pair(ask.columns), '|---|---|',
          ...ask.options.map(option => `| ${pair(option.name)} | ${pair(option.detail)} |`)].join('\n')),
        '--values-file', file({ decide }));
      reply = words('候補を質問にまとめました。', 'The choices are ready for you.');
    } else {
      state.revision++; saveState(id, state);
      const again = state.revision > 1, unmade = words('試用のため、遊べるファイルは作っていません。', 'The preview makes no file to play.');
      const ask = asks[state.example];
      const result = ask ? ask.result(pair(ask.options[state.choice ?? 0].name)) + ' ' + unmade
        : words(again ? '本日開店。ほっとする一杯をどうぞ。' : '新しいカフェが開店します。香りのよいコーヒーと、ゆっくり過ごせる席を用意して、お待ちしています。',
          again ? 'Now open. Stop by for a comforting cup.' : 'Our new café is opening. Enjoy aromatic coffee and a quiet place to unwind. We look forward to welcoming you.');
      const final = words('試用の代役 AI が作った結果です。', 'This result was made by the synthetic preview AI.') + '\n\n' + result;
      cli('task', 'report', '--task', id, '--state', 'done', '--expected-task-hash', current.task.hash,
        '--title', words('結果を確認してください', 'Please review the result'), '--description-file', file(final),
        '--values-file', file({ conclusion: result, decide: null, left_running: ['none'] }));
      reply = final;
    }
  }
  writeFileSync(output, reply); emit({ type: 'turn.completed' });
} catch (error) {
  appendFileSync(join(root, 'actor-errors.log'), String(error.stack ?? error) + '\n');
  emit({ type: 'turn.failed', error: { message: String(error.message ?? error) } }); process.exitCode = 1;
}
