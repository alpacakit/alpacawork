/** One owner for JSONL capture, bounded waits and bridge-process cleanup. */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import type { TestContext } from 'node:test';
import { stopGroup } from './process-groups.ts';

type StdioEntry = 'pipe' | 'ignore' | number;
export function spawnBridge(t: TestContext, args: string[], options: SpawnOptionsWithoutStdio = {}, stdio: readonly StdioEntry[] = ['pipe', 'pipe', 'pipe']) {
  const grouped = process.platform !== 'win32';
  const env = { ...process.env, ...options.env };
  // This isolated three-fd fixture starts a new bridge, not the caller's private runtime.
  delete env.ALPACAWORK_RUN_CLI; delete env.ALPACAWORK_RUNTIME_LEASE_FD;
  const child = spawn(process.execPath, args, { ...options, env, detached: grouped, stdio: stdio as StdioEntry[] }) as ChildProcessWithoutNullStreams;
  const updates = new EventEmitter();
  const rows: any[] = [];
  const decoder = new StringDecoder('utf8');
  let stdout = '', stderr = '', pending = '', fault: Error | undefined, closed = false;
  child.stdout.on('data', chunk => {
    const text = decoder.write(chunk);
    stdout += text;
    pending += text;
    for (let end; (end = pending.indexOf('\n')) >= 0;) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) {
        try { rows.push(JSON.parse(line)); }
        catch (error) { fault = error as Error; }
      }
    }
    updates.emit('change');
  });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.once('error', error => { fault = error; updates.emit('change'); });
  // Subscribe at spawn time and wait for stdio as well as the process to close.
  const exited = new Promise<number | null>(resolve => child.once('close', code => {
    closed = true;
    if (pending.trim()) fault = new Error('Bridge ended with an incomplete JSONL event');
    resolve(code);
    updates.emit('change');
  }));
  const diagnostics = () => `${stdout}\n${stderr}`;
  const until = (check: (events: any[]) => boolean, what = 'bridge condition') => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearInterval(poll);
      clearTimeout(timeout);
      updates.off('change', inspect);
      if (error) reject(error); else resolve();
    };
    const inspect = () => {
      try {
        if (fault) throw fault;
        if (check(rows)) finish();
        else if (closed) finish(new Error(`Bridge closed before ${what}\n${diagnostics()}`));
      } catch (error) { finish(error as Error); }
    };
    // File gates and fake-server requests can change without a stdout event.
    const poll = setInterval(inspect, 20);
    const timeout = setTimeout(() => finish(new Error(`Deadline: ${what}\n${diagnostics()}`)), 10_000);
    updates.on('change', inspect);
    inspect();
  });
  t.after(async () => {
    const waitForClose = (milliseconds: number) => new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (!closed) {
      child.kill('SIGTERM');
      await waitForClose(1000);
    }
    // close only covers the bridge and its stdio; a fake provider may still
    // be running in its detached group. Check actual group members after KILL.
    if (grouped && child.pid) await stopGroup(child.pid);
    else if (!closed) child.kill('SIGKILL');
    if (!closed && !await waitForClose(5000)) throw new Error(`Deadline: bridge close\n${diagnostics()}`);
    if (fault) throw new Error(`Invalid bridge output\n${diagnostics()}`, { cause: fault });
  });
  return { child, exited, until, events: () => rows, stderr: () => stderr,
    send: (id: string, text: string) => child.stdin.write(`${JSON.stringify({ id, text })}\n`) };
}
