/**
 * Many CLI commands in one process: starting Node and loading the CLI is most of what a command costs a test.
 * The commands are the real program's main with the caller's environment, against the real server, one at a time.
 * That the program itself starts and sets its exit status stays with the tests that call cliRun.
 * A command that reads standard input takes its own process, since the input is that process's.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Problem } from '@alpacawork/core';
import { cliCommands } from '@alpacawork/contract/cli-commands';
import { problemSchema } from '@alpacawork/contract/problem';
import { cleanCliEnv, cliRun } from './http-cli.ts';

type Result = { code: number | null; stdout: string; stderr: string };

const program = fileURLToPath(new URL('../../apps/cli/dist/cli.js', import.meta.url));
const driver = `
import { main } from ${JSON.stringify(program)};
const write = { stdout: process.stdout.write, stderr: process.stderr.write };
const home = process.cwd();
process.on('message', async ({ id, args, env, cwd }) => {
  process.chdir(cwd ?? home);
  const taken = { stdout: '', stderr: '' };
  for (const name of ['stdout', 'stderr']) process[name].write = chunk => { taken[name] += chunk; return true; };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  let code;
  try { code = await main(args); }
  finally { Object.assign(process.stdout, { write: write.stdout }); Object.assign(process.stderr, { write: write.stderr }); }
  process.exitCode = 0;
  await new Promise(resolve => setImmediate(resolve));
  const left = process.getActiveResourcesInfo().filter(kind => kind === 'Timeout');
  process.send({ id, code, stdout: taken.stdout, stderr: taken.stderr, left });
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
`;

let child: ChildProcess | undefined;
let last: Promise<unknown> = Promise.resolve();
let sent = 0;
let closing = false;
let died: Error | undefined;
const waiting = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void }>();

function started() {
  if (child) return child;
  // The driver is a module of its own: `-e` keeps process.argv[1] unset, so importing the program does not run it.
  const made = child = spawn(process.execPath, ['--input-type=module', '-e', driver], { env: cleanCliEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  made.on('message', ({ id, left, ...result }: { id?: number; left?: string[] } & Result) => {
    if (id === undefined) return;
    if (left?.length) waiting.get(id)?.reject(new Error('The command left a timer running: the program would not end yet'));
    else waiting.get(id)?.resolve(result);
    waiting.delete(id);
  });
  made.once('exit', (code, signal) => {
    const failure = new Error(`The CLI process ended: ${code ?? signal}`);
    for (const each of waiting.values()) each.reject(failure);
    waiting.clear(); if (child === made) child = undefined;
    if (!closing) died = failure;
  });
  return made;
}
let texts: string | undefined;
after(() => {
  if (texts) rmSync(texts, { recursive: true, force: true });
  closing = true; child?.disconnect(); if (died) throw died;
});

/**
 * A file holding `text`, for a command's file option where a separate program would read `-` from stdin; the commands
 * here share one process and so one stdin. Reading stdin is the CLI's own concern, tested where the CLI starts by itself.
 */
export function textFile(text: string) {
  texts ??= mkdtempSync(join(tmpdir(), 'alpacawork-cli-text-'));
  const file = join(texts, `${randomUUID()}.txt`);
  writeFileSync(file, text);
  return file;
}

/** What cliRun gives, without starting a program per command; it runs in `cwd`, or where the tests run. */
export function cliCommand(url: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '', cwd?: string): Promise<Result> {
  if (input || env.NODE_OPTIONS !== undefined) return cliRun(url, args, env, input);
  const command = () => new Promise<Result>((resolve, reject) => {
    if (died) { reject(died); return; }
    const id = ++sent;
    waiting.set(id, { resolve, reject });
    started().send({ id, args: ['--server', new URL(url).origin, ...args], env: cleanCliEnv(env), cwd });
  });
  const result = last.then(command, command);
  last = result;
  return result;
}

/** A write carries its own operation ID unless one is named; the contract's command table says which commands write. */
const withOpId = (args: string[]) =>
  cliCommands.some(spec => spec.mutation && spec.group === args[0] && spec.name === args[1]) && !args.includes('--op-id')
    ? [...args, '--op-id', randomUUID()] : args;
/** The CLI against `url` as `env` names the caller (a person when it names no one), with its exit status and output. */
export const run = (url: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') => cliCommand(url, withOpId(args), env, input);
/** What the CLI wrote, or its refusal thrown as the Problem it answered with. */
export async function call(url: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  const result = await run(url, args, env, input);
  if (result.code === 0) return JSON.parse(result.stdout);
  let body: unknown = null;
  try { body = JSON.parse(result.stderr); } catch { /* Not a refusal: the failure is reported whole below. */ }
  const refused = problemSchema.safeParse(body);
  if (!refused.success) throw new Error(result.stderr + result.stdout);
  const { code, message, detail, issues } = refused.data.error;
  throw new Problem(code, message, detail, { issues });
}
