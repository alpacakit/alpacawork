/**
 * A synthetic workspace for measuring the analysis at scale: many user-requested Tasks finished over a long record, many
 * ended Runs with usage, and Run outputs (some of several MB) for the tally to read. Fictional text only; every Run has
 * ended and its saved launch targets `/usr/bin/false`. Serve the root it prints like the other scenes.
 */
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { publishImmutable } from '@alpacawork/core';
import { openControlDatabase, taskHash } from '@alpacawork/db';
import { RUN_FILES, runFolder, runRecordSchema } from '@alpacawork/contract/run';
import { storedTaskLogSchema } from '@alpacawork/raw/task-log-schema';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
import { record } from '../../tests/runs-fixtures.ts';

const DAY = 86_400_000, MINUTE = 60_000;
const MODELS: Record<'claude' | 'codex', [string, string | null][]> = {
  claude: [['opus', 'high'], ['sonnet', 'medium'], ['fable', 'high']], codex: [['gpt-6.2-sol', 'high'], ['gpt-6.1-terra', null]] };
const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Write', 'mcp__github__get_pull_request', 'Skill'];

function random(seed: string) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Options = { dest: string; tasks: number; runs: number; days: number; outputs: number; large: number; largeMb: number; until: number; seed: string };

/** A Claude or Codex stream for one Run: tool calls the tally counts, padded with results to about `bytes`. */
function writeOutput(path: string, adapter: 'claude' | 'codex', model: string, session: string, n: number, bytes: number) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    let written = 0, call = 0;
    const line = (value: unknown) => { const text = JSON.stringify(value) + '\n'; writeSync(fd, text); written += Buffer.byteLength(text); };
    const filler = 'Fictional tool output for a synthetic measurement. '.repeat(40);
    if (adapter === 'claude') line({ type: 'system', subtype: 'init', session_id: session, model });
    else line({ type: 'item.completed', item: { id: `cfg-${n}`, type: 'agent_configuration', model } });
    do {
      const tool = TOOLS[(n + call) % TOOLS.length]!, id = `call-${n}-${call++}`;
      if (adapter === 'claude') {
        const input = tool === 'Skill' ? { skill: 'example-skill' } : tool === 'Bash' ? { command: call % 5 ? 'ls' : 'cat /fictional/skills/example-skill/SKILL.md' } : { file_path: '/fictional/file.ts' };
        line({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
        line({ type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: id, content: filler }] } });
      } else {
        const item = tool.startsWith('mcp__') ? { id, type: 'mcp_tool_call', server: 'github', tool: 'get_pull_request' }
          : { id, type: 'command_execution', command: call % 5 ? 'ls' : 'cat /fictional/skills/example-skill/SKILL.md' };
        line({ type: 'item.started', item });
        line({ type: 'item.completed', item: { ...item, aggregated_output: filler } });
      }
    } while (written < bytes);
  } finally { closeSync(fd); }
}

export function generate(options: Options) {
  const root = resolve(options.dest), rand = random(options.seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  mkdirSync(root, { mode: 0o700 });
  const start = options.until - options.days * DAY;
  const iso = (ms: number) => new Date(ms).toISOString();
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
  const outputs: { id: string; adapter: 'claude' | 'codex'; model: string; session: string; n: number; bytes: number }[] = [];
  const counts = { projects: 3, units: options.tasks, children: 0, logs: 0, runs: 0, requests: 0 };
  try {
    db.exec('BEGIN IMMEDIATE');
    const task = db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'active',?,0,?,?,1,?,?)`);
    const value = db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)');
    const placement = db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,'fixture-agent','fixture',1,1,?)`);
    const request = db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
      VALUES(?,?,?,1,?,?,?,?,'{"kind":"human"}',?,'queued')`);
    const run = db.prepare(`INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,'Synthetic instruction.','Synthetic result.','present')`);
    const log = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry,request_id) VALUES(?,?,?,?,?)');
    const question = db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)');
    db.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)').run('fixture-agent', iso(start));
    const internal = (n: number) => `scene-${n}`;
    for (let p = 1; p <= 3; p++)
      task.run(internal(p), 'project', p, null, null, `Synthetic project ${p}`, 'todo', 0, JSON.stringify({ color: '#39659b' }), iso(start), iso(start));

    const templates = { claude: inertFixtureLaunch('claude'), codex: inertFixtureLaunch('codex') };
    const base = runRecordSchema.parse(record('R1', { task: 'T4', placementId: 'p', requestId: 'r', agent: 'claude', role: 'owner',
      state: 'succeeded', created_at: iso(start), started_at: iso(start), ended_at: iso(start), exit: { code: 0, signal: null },
      cwd: root, pids: { manager: 1, agent: 2 }, launch: templates.claude }));
    let number = 4, runNumber = 0;
    const runsPerTask = options.runs / (options.tasks * 1.25);
    const checks = Math.min(200, options.tasks);
    const addRun = (taskId: string, placementId: string, requestId: string, from: number, to: number, session: { id: string } | null, role: 'owner' | 'worker') => {
      const id = ++runNumber, adapter: 'claude' | 'codex' = rand() < 0.7 ? 'claude' : 'codex', [model, effort] = pick(MODELS[adapter]);
      const started = from + rand() * Math.max(MINUTE, to - from), ended = started + MINUTE * (1 + rand() * 40);
      const sessionId = session?.id || `session-${id}`;
      if (session) session.id = sessionId;
      const usage = rand() < 0.03 ? null : { includesEarlier: false, conversation: null, run: {
        input: Math.floor(1_000 + rand() * 50_000), output: Math.floor(500 + rand() * 20_000),
        cacheRead: Math.floor(10_000 + rand() * 500_000), cacheWrite: Math.floor(1_000 + rand() * 50_000) } };
      const value = { ...base, id: `R${id}`, task: taskId, placementId, requestId, agent: adapter, role,
        session: { provider: adapter, id: sessionId }, launch: { ...templates[adapter], values: effort ? { model, effort } : { model } },
        state: 'succeeded', created_at: iso(started - 1000), started_at: iso(started), ended_at: iso(ended), usage };
      if (id <= checks) runRecordSchema.parse(value);
      run.run(id, JSON.stringify(value));
      counts.runs++;
      if (outputs.length < options.large) outputs.push({ id: `R${id}`, adapter, model, session: sessionId, n: id, bytes: options.largeMb * 1024 * 1024 });
      else if (rand() < options.outputs) outputs.push({ id: `R${id}`, adapter, model, session: sessionId, n: id, bytes: 4 * 1024 + rand() * 60 * 1024 });
    };

    for (let u = 0; u < options.tasks; u++) {
      const n = number++, taskId = `T${n}`, project = 1 + (u % 3);
      // More recent days hold more tasks, as a growing workspace does.
      const t0 = start + Math.sqrt(rand()) * (options.days * DAY - 3 * 3_600_000);
      const lead = Math.exp(Math.log(10 * MINUTE) + rand() * Math.log(3 * DAY / (10 * MINUTE)));
      const roll = rand(), end = t0 + lead, open = end > options.until - 60_000;
      const outcome = open ? 'doing' : roll < 0.62 ? 'passed' : roll < 0.85 ? 'reworked' : roll < 0.93 ? 'stopped' : 'passed';
      const state = outcome === 'doing' ? 'doing' : outcome === 'stopped' ? 'stopped' : 'done';
      task.run(internal(n), 'task', n, internal(project), internal(project), `Synthetic task ${n}`, state, 1, null, iso(t0 - 1000), iso(end));
      const owner = `scene-placement-${n}`;
      placement.run(owner, taskId, iso(t0));
      const hash = taskHash(internal(n), 1);
      const pr = rand() < 0.35 ? `https://github.com/fictional/app/pull/${1 + Math.floor(rand() * options.tasks)}` : null;
      value.run(internal(n), 'goal', JSON.stringify(`Finish synthetic task ${n}`));
      if (pr && rand() < 0.5) value.run(internal(n), 'notes', JSON.stringify(`Opened ${pr}`));
      let ordinal = 0;
      const entries: { at: number; entry?: Record<string, unknown>; request?: string }[] = [];
      const event = (at: number, kind: string, extra: Record<string, unknown> = {}) =>
        entries.push({ at, entry: { kind, title: null, description: null, actor: { kind: 'human' }, fromState: null, toState: null, ...extra } });
      event(t0 - 1000, 'created', { title: 'Synthetic task created', toState: 'todo', userRequested: true });
      const instruction = `scene-request-${n}-0`;
      request.run(instruction, taskId, owner, hash, 'new', 'Synthetic instruction.', 'instruction', iso(t0));
      counts.requests++;
      entries.push({ at: t0, request: instruction });
      event(t0 + 1000, 'linked', { fromState: 'todo', toState: 'doing' });
      const asks = rand() < 0.25;
      if (asks) {
        event(t0 + lead * 0.3, 'asked', { actor: { kind: 'placement', placementId: owner }, askedTo: null, title: 'Synthetic question',
          description: 'A fictional question.', decide: [{ title: 'Choose a synthetic option' }] });
        if (!open || rand() < 0.5) event(t0 + lead * 0.4, 'answered', { questionId: 'ask' });
      }
      const submit = (at: number) => event(at, 'reported', { actor: { kind: 'placement', placementId: owner }, fromState: 'doing', toState: 'waiting',
        title: 'Synthetic result ready', description: pr ? `Fictional result in ${pr}` : 'Fictional result.' });
      let sendBack: string | null = null;
      if (outcome === 'passed' || outcome === 'reworked') {
        submit(t0 + lead * 0.6);
        if (outcome === 'reworked') {
          sendBack = `scene-request-${n}-1`;
          request.run(sendBack, taskId, owner, hash, 'continue', 'Synthetic send-back.', 'review_send_back', iso(t0 + lead * 0.7));
          counts.requests++;
          entries.push({ at: t0 + lead * 0.7, request: sendBack });
          event(t0 + lead * 0.7 + 1000, 'linked', { fromState: 'waiting', toState: 'doing' });
          submit(t0 + lead * 0.9);
        }
        event(end, 'review_approved', { fromState: 'waiting', toState: 'done' });
      } else if (outcome === 'stopped') event(end, 'reported', { fromState: 'doing', toState: 'stopped', title: 'Synthetic stop' });

      // Runs: the first answers the instruction, a send-back has its own, the rest their own requests outside the log.
      const session = { id: '' }, last = open ? options.until - 60_000 : end;
      const spread = Math.max(1, Math.round(runsPerTask * (0.5 + rand())));
      for (let r = 0; r < spread; r++) {
        let requestId: string;
        if (r === 0) requestId = instruction;
        else if (r === 1 && sendBack) requestId = sendBack;
        else {
          requestId = `scene-request-${n}-r${r}`;
          request.run(requestId, taskId, owner, hash, 'continue', 'Synthetic follow-up.', 'instruction', iso(t0));
          counts.requests++;
        }
        addRun(taskId, owner, requestId, r === 0 ? t0 : t0 + 2000, Math.min(last, t0 + lead), rand() < 0.3 ? session : null, r === 0 || rand() < 0.6 ? 'owner' : 'worker');
      }
      entries.sort((a, b) => a.at - b.at);
      let asked: string | null = null;
      for (const item of entries) {
        const logId = item.request ?? `scene-log-${n}-${ordinal}`;
        if (item.entry) {
          const entry: Record<string, unknown> = { id: logId, at: iso(item.at), ...item.entry };
          if (entry.kind === 'asked') asked = logId;
          if (entry.kind === 'answered') entry.questionId = asked;
          if (u < checks) storedTaskLogSchema.parse(entry);
          log.run(logId, internal(n), ordinal++, JSON.stringify(entry), null);
          if (entry.kind === 'answered') question.run(logId, asked);
        } else log.run(logId, internal(n), ordinal++, null, item.request!);
        counts.logs++;
      }
      // Every fourth task has a child of its own: its Runs count toward the task above it.
      if (u % 4 === 0) {
        const c = number++, childId = `T${c}`, childPlacement = `scene-placement-${c}`;
        task.run(internal(c), 'task', c, internal(n), internal(project), `Synthetic child ${c}`, open ? 'doing' : 'done', 0, null, iso(t0 + 2000), iso(end));
        placement.run(childPlacement, childId, iso(t0 + 2000));
        log.run(`scene-log-${c}-0`, internal(c), 0, JSON.stringify({ id: `scene-log-${c}-0`, kind: 'created', at: iso(t0 + 2000), title: 'Synthetic child created',
          description: null, actor: { kind: 'placement', placementId: owner }, fromState: null, toState: 'todo', userRequested: false }), null);
        counts.children++; counts.logs++;
        const childRuns = Math.max(1, Math.round(runsPerTask / 2));
        for (let r = 0; r < childRuns; r++) {
          const requestId = `scene-request-${c}-r${r}`;
          request.run(requestId, childId, childPlacement, taskHash(internal(c), 1), 'new', 'Synthetic child instruction.', 'instruction', iso(t0 + 2000));
          counts.requests++;
          addRun(childId, childPlacement, requestId, t0 + 3000, Math.min(last, t0 + lead), null, 'owner');
        }
      }
    }
    db.prepare('UPDATE task_sequence SET next_number=?').run(number);
    db.prepare('UPDATE run_sequence SET next_number=?').run(runNumber + 1);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); }
  // Tally the whole record: the collection is taken to have started on the first day.
  publishImmutable(join(root, '.alpacawork'), 'analysis-tally-since', iso(start));
  let bytes = 0;
  for (const output of outputs) {
    const folder = runFolder(root, output.id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeOutput(join(folder, RUN_FILES.stdout), output.adapter, output.model, output.session, output.n, output.bytes);
    bytes += output.bytes;
  }
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: {
    claude: { ...fixtureAgentSetting('claude'), enabled: false }, codex: { ...fixtureAgentSetting('codex'), enabled: false } } }));
  return { root, from: iso(start), until: iso(options.until), ...counts, outputs: outputs.length, outputBytes: Math.round(bytes) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    dest: { type: 'string' }, tasks: { type: 'string', default: '30000' }, runs: { type: 'string', default: '300000' },
    days: { type: 'string', default: '450' }, outputs: { type: 'string', default: '0.03' }, large: { type: 'string', default: '12' },
    'large-mb': { type: 'string', default: '4' }, until: { type: 'string' }, seed: { type: 'string', default: 'analysis-scene-v1' },
  } });
  if (!values.dest) throw new Error('Usage: node scripts/dev-fixtures/analysis-scene.ts --dest NEW_ROOT [--tasks N --runs N --days N --outputs FRACTION --large N --large-mb MB --until ISO --seed TEXT]');
  const started = performance.now();
  const result = generate({ dest: values.dest, tasks: Number(values.tasks), runs: Number(values.runs), days: Number(values.days),
    outputs: Number(values.outputs), large: Number(values.large), largeMb: Number(values['large-mb']),
    until: values.until ? Date.parse(values.until) : Date.now(), seed: values.seed! });
  console.log(JSON.stringify({ ...result, generationMs: Math.round(performance.now() - started) }, null, 2));
}
