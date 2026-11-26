import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, isAbsolute, resolve } from 'node:path';
import type { StepHead } from '@alpacawork/contract/run';
import { shellScript } from '../agents/adapters/activity.js';
import { object } from '../agents/adapters/output.js';
import type { ActivityEvent, StepCall } from './activity-events.js';
import { simpleInvocations } from './shell-command.js';

export const evidenceDigest = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

export function rawInputDigest(event: ActivityEvent, cwd?: string): string | undefined {
  if (event.dropped) return;
  const shell = shellInput(event.call, String(event.stepTool ?? event.toolName), event.input);
  if (shell) {
    if (shell.script === null || event.call?.clipped?.cwd) return;
    const dir = cwd === undefined ? shell.cwd : shellDirectory(cwd, shell)?.dir ?? shell.cwd;
    return evidenceDigest(JSON.stringify([shell.script, dir]));
  }
  if (event.call && !Object.values(event.call.clipped ?? {}).some(count => count > 0)) {
    const input = JSON.stringify(event.call.input);
    return input === undefined ? undefined : evidenceDigest(JSON.stringify([event.call.tool, input]));
  }
  if (!event.call && event.input?.text && !event.input.omitted)
    return evidenceDigest(JSON.stringify([event.toolName, event.input.text]));
}

const shellTools = new Set(['bash', 'shell', 'powershell', 'command_execution', 'codex:command_execution']);
export function shellInput(call: StepCall | undefined, tool: string, text?: { text: string; omitted: number }) {
  if (!shellTools.has((call?.tool ?? tool).toLowerCase()) && !shellTools.has(tool.toLowerCase())) return;
  if (call) {
    const { command, cwd } = object(call.input);
    const raw = call.tool === 'codex:command_execution' ? shellScript(command, !!call.clipped?.command) : command;
    return { script: typeof raw === 'string' && !call.clipped?.command ? raw : null,
      cwd: typeof cwd === 'string' && !call.clipped?.cwd ? cwd : null };
  }
  return { script: text && text.omitted === 0 ? text.text : null, cwd: null };
}

/** Skip command wrappers with recognized options, leaving unknown command syntax alone. */
function invocation(words: (string | null)[]): [string, ...(string | null)[]] {
  const at = words.findIndex(word => word === null || !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word));
  if (at < 0) return [''];
  const [exe, ...args] = words.slice(at), program = exe ? basename(exe) : '';
  if (program === 'env') {
    let i = 0;
    for (; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--') { i++; break; }
      if (flag === '-i' || flag === '--ignore-environment' || flag?.startsWith('--unset=')) continue;
      if (flag === '-u' || flag === '--unset') { i++; continue; }
      break;
    }
    return invocation(args.slice(i));
  }
  if (program === 'timeout') {
    let i = 0;
    for (; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--') { i++; break; }
      if (['--foreground', '--preserve-status', '-v', '--verbose'].some(option => option === flag) ||
          flag?.startsWith('--signal=') || flag?.startsWith('--kill-after=')) continue;
      if (['-s', '--signal', '-k', '--kill-after'].some(option => option === flag)) { i++; continue; }
      break;
    }
    return /^[0-9]+(?:\.[0-9]+)?[smhd]?$/.test(args[i] ?? '') ? invocation(args.slice(i + 1)) : ['', ...args];
  }
  return [program, ...args];
}

const packageManagers = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const runners = new Set(['vitest', 'jest', 'pytest', 'playwright']);
const wrappers = new Set(['npx', 'pnpx', 'bunx']);
const testScript = (word: string | null | undefined) => !!word && /^test(?:$|[:_-])/.test(word);

function runsTest(words: (string | null)[]): boolean {
  const [program, ...args] = invocation(words);
  if (wrappers.has(program)) return runsTest(args[0] === '--' ? args.slice(1) : args);
  if (packageManagers.has(program)) {
    const [, remaining] = packageArguments(program, args);
    const [verb, script, ...rest] = remaining;
    return testScript(verb) || (verb === 'run' || verb === 'run-script') && testScript(script) ||
      (verb === 'exec' || verb === 'dlx') && runsTest([script ?? null, ...rest]) ||
      !!verb && runners.has(verb) && runsTest(remaining);
  }
  if (runners.has(program)) return program !== 'playwright' || args[0] === 'test';
  if (program === 'go' || program === 'cargo') return args[0] === 'test';
  if (program === 'node') return args.slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--')).includes('--test');
  return false;
}

export const isTestCommand = (script: string): boolean => [...simpleInvocations(script)].some(runsTest);

function commandDirectoryOption(args: (string | null)[]) {
  const flag = args[0];
  if (flag === '-C' || flag === '--dir' || flag === '--prefix' || flag === '--cwd')
    return { dir: args[1] ?? null, args: args.slice(2) };
  const inline = flag && /^--(?:dir|prefix|cwd)=(.+)$/.exec(flag);
  return inline ? { dir: inline[1]!, args: args.slice(1) } : { dir: undefined, args };
}

function packageArguments(program: string, words: (string | null)[]): [string | null | undefined, (string | null)[]] {
  let dir: string | null | undefined, args = words;
  while (args.length) {
    const option = commandDirectoryOption(args);
    if (option.dir !== undefined) { dir = option.dir; args = option.args; continue; }
    const flag = args[0];
    if (program === 'pnpm' && (flag === '-w' || flag === '--workspace-root')) { args = args.slice(1); continue; }
    if (flag === '--filter' || flag === '-F' || flag === '--workspace' || flag === '-w') { args = args.slice(2); continue; }
    if (flag?.startsWith('--filter=') || flag?.startsWith('--workspace=')) { args = args.slice(1); continue; }
    break;
  }
  return [dir, args];
}

/** Resolve only working directories that the tool or a literal command declares. */
export function shellDirectory(cwd: string, shell: { script: string | null; cwd: string | null }): Pick<StepHead, 'dir' | 'dirSource'> | null {
  let dir = shell.cwd ? resolve(cwd, shell.cwd) : cwd;
  if (!isAbsolute(dir)) return null;
  const commands = [...simpleInvocations(shell.script)];
  let dirSource: StepHead['dirSource'] = shell.cwd ? 'tool' : 'cwd';
  let i = 0;
  for (; i < commands.length; i++) {
    const [program, target, ...rest] = invocation(commands[i]!);
    if (program !== 'cd') break;
    if (!target || target.startsWith('-') || target.startsWith('~') || rest.length) return null;
    dir = resolve(dir, target);
    dirSource = isAbsolute(target) ? 'command' : 'relative-command';
  }
  const [program, ...args] = invocation(commands[i] ?? []);
  const option = program === 'git' ? commandDirectoryOption(args).dir : packageManagers.has(program) ? packageArguments(program, args)[0] : undefined;
  if (option === null || option?.startsWith('~')) return null;
  return option ? { dir: resolve(dir, option), dirSource: isAbsolute(option) ? 'command' : 'relative-command' } : { dir, dirSource };
}

/** A manager observation, bounded even for an inaccessible or busy checkout. */
export function checkoutAt(cwd: string, shell: NonNullable<ReturnType<typeof shellInput>>): StepHead | null {
  const location = shellDirectory(cwd, shell);
  if (!location) return null;
  const { dir } = location;
  const started = performance.now();
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-C', dir, ...args], {
    timeout: Math.max(1, Math.floor(5000 - (performance.now() - started))), killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Use the same commit for the digest even if another process moves HEAD.
  try {
    const [inside, commit] = git('rev-parse', '--is-inside-work-tree', 'HEAD').toString('utf8').trim().split('\n');
    if (inside !== 'true' || !commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return null;
    try {
      const diff = git('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--binary', commit, '--');
      return { ...location, commit, dirty: diff.length > 0, ...(diff.length ? { diffDigest: evidenceDigest(diff) } : {}) };
    } catch (error) {
      const failure = error as { code?: string };
      return { ...location, commit, dirty: failure.code === 'ENOBUFS' ? true : null };
    }
  } catch { return null; }
}

export type ShellProduction = 'commit' | 'created' | 'merged';
export function shellProduction(script: string): Set<ShellProduction> {
  const matches = new Set<ShellProduction>();
  for (const words of simpleInvocations(script)) {
    const [program, ...args] = invocation(words);
    if (program === 'git' && commandDirectoryOption(args).args[0] === 'commit') matches.add('commit');
    if (program === 'gh' && args[0] === 'pr') {
      if (args[1] === 'create') matches.add('created');
      if (args[1] === 'merge' && !args.includes('--auto') && !args.includes('--disable-auto')) matches.add('merged');
    }
  }
  return matches;
}
