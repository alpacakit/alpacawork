/**
 * Explicit, paid real-agent gate for the current DB and HTTP CLI Task report path.
 * It is never part of pnpm test:all. Usage: pnpm test:real-agents [<evidence-dir>]
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedServe } from '../helpers/http-cli.ts';

const out = process.argv[2] ? resolve(process.argv[2]) : realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-real-evidence-')));
const backend = new URL('../../apps/backend/dist/backend.js', import.meta.url).pathname;
const cli = new URL('../../apps/cli/dist/cli.js', import.meta.url).pathname;
if (!existsSync(backend)) throw new Error(`Build first: ${backend} is missing`);
if (!existsSync(cli)) throw new Error(`Build first: ${cli} is missing`);
mkdirSync(out, { recursive: true });
const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-real-')));
const root = join(area, 'root'), bin = join(area, 'bin');
for (const dir of [root, bin]) mkdirSync(dir, { recursive: true });
const bridge = new URL('../../apps/agent-cli/dist/cli.js', import.meta.url).pathname;
if (!existsSync(bridge)) throw new Error(`Build first: ${bridge} is missing`);
for (const [name, entry] of [['alpacawork', cli], ['alpacawork-agent', bridge]]) {
  writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`);
  chmodSync(join(bin, name), 0o755);
}
const agentsDir = dirname(execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim());
const env = { ...process.env, PATH: [bin, dirname(process.execPath), agentsDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') };
for (const key of Object.keys(env)) if (key === 'CLAUDE_CODE_SESSION_ID' || key === 'CLAUDECODE' || key.startsWith('CODEX_') || key === 'ALPACAWORK_RUN' || key === 'ALPACAWORK_RUN_TOKEN') delete env[key];
const lines = [];
const log = text => { lines.push(text); console.log(text); };
let failures = 0;
let server;
const check = (ok, text) => { if (!ok) failures++; log(`${ok ? 'PASS' : 'FAIL'} ${text}`); };
function alpacawork(...argv) {
  const local = argv[0] === 'workspace' && argv[1] === 'init';
  const mutation = ['new', 'update', 'request', 'report', 'move', 'comment', 'set', 'returns', 'assign', 'release', 'stop'].includes(argv[1]);
  const args = [...(local ? ['--workspace', root] : ['--server', server.url]), ...argv,
    ...(!local && mutation && !argv.includes('--op-id') ? ['--op-id', randomUUID()] : [])];
  const result = spawnSync(local ? backend : join(bin, 'alpacawork'), args, { env: local ? { ...env, XDG_CONFIG_HOME: join(area, 'server-config') } : env, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`alpacawork ${argv.join(' ')} exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const runs = () => alpacawork('task', 'list').tasks.flatMap(task => alpacawork('task', 'get', '--task', task.id, '--runs', '1000').runs);
const reply = id => alpacawork('run', 'get', '--run', id).files[0].text ?? '';
const file = (id, name) => { try { return readFileSync(join(root, '.alpacawork/runs', id, name), 'utf8'); } catch { return null; } };
async function until(label, predicate, ms = 600_000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = predicate(runs());
    if (found) return found;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await delay(2000);
  }
}
const ended = run => ['succeeded', 'failed', 'cancelled', 'needs_review', 'joined'].includes(run.state);
const codexConfig = join(homedir(), '.codex/config.toml');
const codexBefore = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
try {
  log(`area ${area}`); log(`evidence ${out}`);
  log(`claude ${execFileSync(join(agentsDir, 'claude'), ['--version'], { encoding: 'utf8' }).trim()}; codex ${execFileSync(join(agentsDir, 'codex'), ['--version'], { encoding: 'utf8' }).trim()}`);
  alpacawork('workspace', 'init');
  server = await isolatedServe(root, undefined, { ALPACAWORK_TEST_SERVER_TTL_MS: String(30 * 60_000) });
  env.ALPACAWORK_SERVER = server.url;
  // A new workspace has one project, T1, where a person's Task goes when it names no parent.
  const tasks = { claude: alpacawork('task', 'new', '--title', 'Real Claude').task,
    codex: alpacawork('task', 'new', '--title', 'Real Codex').task };
  let yaml = readFileSync(join(root, 'config.yaml'), 'utf8');
  const template = yaml;
  yaml = yaml.replace(/(\[claude, -p, .*?, none)\]/g, '$1, --model, haiku, --setting-sources, "project,local"]');
  yaml = yaml.replace(/\[alpacawork-agent, codex, /g, `[alpacawork-agent, codex, --disable, hooks, -m, gpt-6-luna, -c, 'model_reasoning_effort="low"', `);
  check(yaml.split('--setting-sources').length === 3 && yaml.split('--disable, hooks').length === 3 &&
    !/(start|resume): \[.*\{prompt\}/.test(yaml),
    'real-agent template has only model and hook-source flags changed');
  writeFileSync(join(root, 'config.yaml'), yaml);
  writeFileSync(join(out, 'agents.template.yaml'), template);
  writeFileSync(join(out, 'config.yaml'), yaml);
  const placements = {};
  for (const agent of ['claude', 'codex']) {
    const task = tasks[agent];
    placements[agent] = alpacawork('agent', 'assign', '--task', task.id, '--role', 'responsible',
      '--profile', agent, '--expected-task-hash', task.hash).agent.placement;
  }
  function request(agent, mode, body, head) {
    // An owner Run that ended without a report errs its Task: the next instruction retries it.
    const task = alpacawork('task', 'get', '--task', tasks[agent].id).task, placement = placements[agent];
    const bodyFile = join(root, `${agent}-${randomUUID()}.md`);
    writeFileSync(bodyFile, body);
    return alpacawork('task', 'request', '--task', task.id, '--instruction-file', bodyFile,
      '--op-id', randomUUID(), '--expected-task-hash', task.hash,
      '--expected-placement-revision', String(placement.revision),
      ...(mode === 'new' ? ['--new-conversation'] : []),
      ...(head ? ['--expected-head-run', head] : [])).outcome.request;
  }
  const words = { claude: 'APRICOT', codex: 'BLUEBERRY' };
  const test = 'The user is checking how instructions reach you while you work; this task needs no alpacawork records.';
  const steps = agent => agent === 'claude' ? '"type":"tool_use"' : '"type":"command_execution"';
  const ends = agent => agent === 'claude' ? '"type":"result"' : '"type":"turn.completed"';
  /** Send `work`; once its agent has started a command, send `steer`; both end in one Run. */
  async function steered(agent, mode, head, label) {
    const marker = join(area, `${agent}-${label}.txt`);
    const work = request(agent, mode, `${test} Run the shell command \`sleep 4\` three times, as three separate commands one after another. Then reply with only ${words[agent]}.`, head);
    await until(`${agent} ${label} starts a command`, () => (file(work.runId, 'stdout.log') ?? '').includes(steps(agent)));
    const steer = request(agent, 'continue', `${test} The user adds to the work you are doing now: also write the single word ${label.toUpperCase()} into the file ${marker}, then continue that work.`);
    const [owner, joined] = await until(`${agent} ${label} ends`, list => {
      const owner = list.find(run => run.id === work.runId), joined = list.find(run => run.id === steer.runId);
      return owner && joined && ended(owner) && ended(joined) && [owner, joined];
    });
    const written = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
    log(`${agent} ${label}: ${owner.id} ${owner.state} resumes=${owner.resumes}; ${joined.id} ${joined.state} into=${joined.into}; file=${JSON.stringify(written)}`);
    check(owner.state === 'succeeded' && joined.state === 'joined' && joined.into === owner.id &&
      written === label.toUpperCase() && reply(owner.id).toUpperCase().includes(words[agent]),
      `${agent}: an instruction sent during the ${label} Run joined it and was followed`);
    return owner;
  }
  for (const agent of ['claude', 'codex']) {
    const owner = await steered(agent, 'new', undefined, 'steer-new');
    check(!!owner.session?.id, `${agent}: Task/Placement/Request started a successful session`);
    const second = request(agent, 'continue', `Reply with only ${words[agent]} again.`, owner.id);
    const continued = await until(`${agent} continuation ends`, list => list.find(run => run.id === second.runId && ended(run)));
    check(continued.state === 'succeeded' && continued.resumes === owner.id && continued.session?.id === owner.session?.id &&
      reply(continued.id).toUpperCase().includes(words[agent]),
      `${agent}: current placement continuation retained the session`);
    const resumed = await steered(agent, 'continue', continued.id, 'steer-resume');
    check(resumed.resumes === continued.id && resumed.session?.id === owner.session?.id, `${agent}: the steered continuation resumed the session`);
    // An instruction sent the moment the work ends either reaches the same agent as its next round or waits for the next Run.
    const last = request(agent, 'continue', 'Reply with only LAST.', resumed.id);
    await until(`${agent} last work ends`, () => (file(last.runId, 'stdout.log') ?? '').includes(ends(agent)), 120_000);
    const after = request(agent, 'continue', 'Reply with only AFTER.');
    const [lastRun, afterRun] = await until(`${agent} end-of-work instruction ends`, list => {
      const one = list.find(run => run.id === last.runId), two = list.find(run => run.id === after.runId);
      return one && two && ended(one) && ended(two) && [one, two];
    });
    const answered = afterRun.state === 'joined' ? reply(lastRun.id) : reply(afterRun.id);
    log(`${agent} end: ${lastRun.id} ${lastRun.state}; ${afterRun.id} ${afterRun.state} into=${afterRun.into} resumes=${afterRun.resumes}`);
    check(lastRun.state === 'succeeded' && (afterRun.state === 'joined' && afterRun.into === lastRun.id ||
      afterRun.state === 'succeeded' && afterRun.resumes === lastRun.id) && answered.toUpperCase().includes('AFTER'),
      `${agent}: an instruction sent as the work ended was ${afterRun.state === 'joined' ? 'taken as the same agent\'s next round' : 'delivered as the next Run'}`);
  }
  const final = runs();
  writeFileSync(join(out, 'runs.json'), JSON.stringify(final, null, 2));
  check(final.every(run => run.state === 'succeeded' || run.state === 'joined'), `all ${final.length} Runs succeeded or joined`);
} catch (error) {
  failures++; log(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await server?.stop();
  if (existsSync(join(root, '.alpacawork/runs'))) cpSync(join(root, '.alpacawork/runs'), join(out, 'runs'), { recursive: true });
  if (existsSync(join(root, '.alpacawork/alpacawork.sqlite')))
    cpSync(join(root, '.alpacawork/alpacawork.sqlite'), join(out, 'alpacawork.sqlite'));
  const codexAfter = existsSync(codexConfig) ? readFileSync(codexConfig, 'utf8') : '';
  const added = codexAfter.split('\n').filter(line => !codexBefore.split('\n').includes(line));
  writeFileSync(join(out, 'codex-config-added-lines.txt'), added.join('\n') + '\n');
  log(`~/.codex/config.toml added lines: ${added.length}`);
  await delay(3000);
  const left = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(area));
  writeFileSync(join(out, 'leftover-processes.txt'), left.join('\n'));
  check(left.length === 0, `no process left in ${area}`);
  rmSync(area, { recursive: true, force: true });
  log(failures ? `RESULT FAIL (${failures})` : 'RESULT PASS');
  writeFileSync(join(out, 'result.txt'), lines.join('\n') + '\n');
  process.exitCode = failures ? 1 : 0;
}
