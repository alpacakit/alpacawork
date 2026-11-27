/** One short-lived agent process for a model-free check: its own process group, bounded output, stopped by the caller's signal. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { agentEnvironment } from '../runs/env.js';
import { appRoot } from '../app-paths.js';

export type InspectionEnvironment = { cwd: string; env: Readonly<Record<string, string | undefined>>; bridge?: readonly string[] };
export type Probe = { status: number | null; stdout: string; failed: boolean };

/** The bundled bridge (`alpacawork-agent <id>`), or the agent's own executable. */
export function probeArgv(id: BuiltinAdapterId, command: string | null, environment: InspectionEnvironment): string[] {
  return command === null ? [...(environment.bridge ?? [process.execPath, join(appRoot(import.meta.url), 'apps/agent-cli/dist/cli.js')]), id] : [command];
}

export function probe(argv: readonly string[], environment: InspectionEnvironment, names: readonly string[], signal: AbortSignal,
  { input = null, limit = 64 * 1024, acceptLine }: { input?: string | null; limit?: number; acceptLine?: (line: string) => boolean } = {}): Promise<Probe> {
  if (signal.aborted) return Promise.resolve({ status: null, stdout: '', failed: true });
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: environment.cwd,
      env: agentEnvironment(environment.env, environment.env.PATH ?? '', undefined, names),
      detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', size = 0, failed = false, tail = '';
    const decoder = new StringDecoder('utf8');
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
    const abort = () => { failed = true; stop(); };
    signal.addEventListener('abort', abort, { once: true });
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (data: Buffer) => {
      size += data.length;
      if (size > limit) abort();
      else if (stream === child.stdout) {
        const text = decoder.write(data);
        stdout += text;
        if (acceptLine) {
          const lines = (tail + text).split('\n');
          tail = lines.pop()!;
          for (const line of lines) if (line && !acceptLine(line)) abort();
        }
      }
    });
    if (input !== null) { child.stdin!.on('error', () => { failed = true; }); child.stdin!.end(input); }
    child.once('error', () => { failed = true; });
    child.once('close', (status, exitSignal) => {
      signal.removeEventListener('abort', abort);
      const remaining = decoder.end();
      if (acceptLine && tail + remaining && !acceptLine(tail + remaining)) failed = true;
      stop();
      resolve({ status, stdout: stdout + remaining, failed: failed || exitSignal !== null });
    });
  });
}
