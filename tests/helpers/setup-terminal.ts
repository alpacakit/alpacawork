/** A real controlling terminal for packaged setup, including the first approval write audit. */
import { constants, accessSync, closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, basename, join, resolve, relative } from 'node:path';
import { constants as osConstants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { linuxPidfd } from '../../scripts/lib/pidfd.ts';

type TerminalAnswer = 'enter' | 'yes' | 'YES' | 'no' | 'cancel' | 'eof';
interface Config {
  home: string; cwd: string; env: NodeJS.ProcessEnv; output: string; command: string[];
  answer: TerminalAnswer | TerminalAnswer[];
  umask?: number; baselineSeconds?: number; trace?: { prefix: string; paths?: string[] };
  runtimeOwnedPaths?: string[]; runtimeOwnedRoots?: string[]; runtimeOwnedPublications?: string[];
}
type Row = [string, number, string | null];
type Change = { path: string; before: Row | null; atPrompt: Row | null };
const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
const fcntl = libc.func('int fcntl(int fd, int command, ...)');
const config: Config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const wallTime = () => (performance.timeOrigin + performance.now()) / 1000;
const comparePaths = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

if (process.argv[3] === '--terminal-child') {
  // libuv's detached spawn calls setsid before starting this fresh runtime. Never
  // fork an initialized Node runtime and execute JavaScript in its child branch.
  const ioctl = libc.func('int ioctl(int fd, unsigned long request, ...)');
  if (ioctl(0, process.platform === 'darwin' ? 0x20007461 : 0x540e, 'int', 0) !== 0)
    throw new Error(`Cannot acquire controlling terminal: errno ${koffi.errno()}`);
  // A fresh Node runtime marks standard descriptors close-on-exec on startup.
  for (const fd of [0, 1, 2]) if (fcntl(fd, 2, 'int', 0) !== 0)
    throw new Error(`Cannot preserve terminal descriptor ${fd}: errno ${koffi.errno()}`);
  process.umask(config.umask ?? 0o022);
  process.chdir(config.cwd);
  const command = tracedCommand();
  const executable = command[0]!.includes('/') ? resolve(command[0]!) : (config.env.PATH ?? '/usr/bin:/bin').split(':')
    .map(path => resolve(path, command[0]!)).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
  if (!executable) throw new Error(`Command not found: ${command[0]}`);
  const env = Object.fromEntries(Object.entries(config.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  process.execve!(executable, command, env);
  throw new Error('execve returned');
}

function tracedCommand() {
  if (!config.trace?.prefix) return config.command;
  return ['strace', '-D', '-I1', '-ff', '-qq', '-ttt', '-yy', '-s', '4096', '-e',
    'trace=open,openat,openat2,creat,write,pwrite64,mmap,mkdir,mkdirat,rename,renameat,renameat2,unlink,unlinkat,rmdir,chmod,fchmod,fchmodat,truncate,ftruncate',
    '-e', 'raw=write,pwrite64', '-o', config.trace.prefix, ...config.command];
}
function snapshot(root: string): Row[] | null {
  if (!existsSync(root)) return null;
  const names: string[] = [];
  function walk(path: string) {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      try { const info = lstatSync(file); names.push(file); if (info.isDirectory()) walk(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  walk(root);
  const rows: Row[] = [];
  for (const file of [root, ...names.sort(comparePaths)]) {
    try {
      const info = lstatSync(file);
      rows.push([relative(root, file) || '.', info.mode, info.isSymbolicLink() ? readlinkSync(file) : info.isFile() ? createHash('sha256').update(readFileSync(file)).digest('hex') : null]);
    } catch (error) {
      // A live backend may finish an atomic replacement during this observation.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return rows;
}
function changes(before: Row[] | null, after: Row[] | null): Change[] {
  const a = new Map((before ?? []).map(row => [row[0], row])), b = new Map((after ?? []).map(row => [row[0], row]));
  return [...new Set([...a.keys(), ...b.keys()])].sort(comparePaths).filter(path => JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path)))
    .map(path => ({ path, before: a.get(path) ?? null, atPrompt: b.get(path) ?? null }));
}
const publisherScratch = (name: string) => /^tmp-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name);
const within = (path: string, root: string) => path === root || path.startsWith(root + '/');
function beforeEnterWrites(promptTime: number) {
  const prefix = config.trace!.prefix;
  const traces = readdirSync(dirname(prefix)).filter(name => name.startsWith(basename(prefix) + '.'));
  if (!traces.length) throw new Error('CLI write trace is missing');
  const publications = (config.runtimeOwnedPublications ?? []).map(path => join(config.home, path));
  // Every subtree omitted from the snapshot must still reject CLI mutations.
  const owned = [...(config.trace!.paths ?? []), ...(config.runtimeOwnedRoots ?? [])].map(path => join(config.home, path));
  const writes: { pid: number; syscall: string }[] = [];
  for (const file of traces) for (const line of readFileSync(join(dirname(prefix), file), 'utf8').split('\n')) {
    if (!/O_RDWR|O_WRONLY|O_CREAT|O_TRUNC|\b(?:creat|mkdir|mkdirat|rename|renameat|renameat2|unlink|unlinkat|rmdir|chmod|fchmod|fchmodat|truncate|ftruncate)\(/.test(line) || Number(line.split(/\s+/)[0]) > promptTime) continue;
    const annotations = [...line.matchAll(/<(\/[^>]+)>/g)].map(match => match[1]!);
    const paths = [...annotations], base = annotations[0] ?? config.cwd;
    for (const quoted of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) paths.push(resolve(base, JSON.parse(quoted[0])));
    if (paths.some(path => owned.some(root => within(path, root)) || publications.some(publication => dirname(path) === dirname(publication) && publisherScratch(basename(path)))))
      writes.push({ pid: Number(file.slice(file.lastIndexOf('.') + 1)), syscall: line });
  }
  return writes;
}

async function main() {
  const tracePrefix = config.trace?.prefix ?? null;
  if ((config.runtimeOwnedPublications?.length || config.runtimeOwnedRoots?.length) && !tracePrefix) throw new Error('Runtime observation requires the CLI write trace');
  const baselineBefore = snapshot(config.home), baselineStart = wallTime();
  if (config.baselineSeconds) await delay(config.baselineSeconds * 1000);
  const before = snapshot(config.home), baselineChanges = changes(baselineBefore, before);
  const openpt = libc.func('int posix_openpt(int flags)'), grantpt = libc.func('int grantpt(int fd)'), unlockpt = libc.func('int unlockpt(int fd)'), ptsname = libc.func('str ptsname(int fd)');
  const fd = openpt(constants.O_RDWR | constants.O_NOCTTY | constants.O_NONBLOCK);
  if (fd < 0) throw new Error(`Cannot open PTY: errno ${koffi.errno()}`);
  let child: ReturnType<typeof spawn> | undefined, status: number | null = null, tracerFd: number | null = null, tracerPid: number | null = null;
  let exit: Promise<void> | undefined, spawnError: Error | undefined;
  const deadline = performance.now() + 120_000;
  const poll = tracePrefix ? libc.func('int poll(void *fds, unsigned long count, int timeout)') : null;
  const pidfd = tracePrefix ? linuxPidfd() : null;
  async function waitTracer() {
    const pollfd = Buffer.alloc(8); pollfd.writeInt32LE(tracerFd!); pollfd.writeInt16LE(1, 4);
    while (performance.now() < deadline) {
      const ready = poll!(pollfd, 1, 0);
      if (ready < 0) throw new Error(`Cannot wait for CLI tracer: errno ${koffi.errno()}`);
      if (ready) return;
      await delay(10);
    }
    throw new Error('CLI tracer did not detach before approval');
  }
  async function detachTrace() {
    if (!tracePrefix) return;
    const status = readFileSync(`/proc/${child!.pid}/status`, 'utf8');
    const tracer = Number(status.match(/^TracerPid:\s+(\d+)/m)?.[1]);
    if (!tracer) throw new Error('CLI was not traced before approval');
    tracerPid = tracer;
    tracerFd = pidfd!.open(tracer, 0);
    if (tracerFd < 0) throw new Error(`Cannot open CLI tracer pidfd: errno ${koffi.errno()}`);
    // -D keeps the CLI as our direct child. Detach before answering so an
    // approved service descendant cannot keep strace and the PTY alive.
    if (pidfd!.send(tracerFd, osConstants.signals.SIGINT, null, 0) !== 0) throw new Error(`Cannot detach CLI tracer: errno ${koffi.errno()}`);
    await waitTracer(); closeSync(tracerFd); tracerFd = null;
  }
  try {
    if (fcntl(fd, 2, 'int', 1) !== 0) throw new Error(`Cannot set PTY close-on-exec: errno ${koffi.errno()}`);
    if (grantpt(fd) !== 0 || unlockpt(fd) !== 0) throw new Error(`Cannot initialize PTY: errno ${koffi.errno()}`);
    const slave = openSync(ptsname(fd), constants.O_RDWR | constants.O_NOCTTY);
    try {
      child = spawn(process.execPath, [import.meta.filename, process.argv[2]!, '--terminal-child'], {
        detached: true, stdio: [slave, slave, slave], env: { ...process.env, NODE_OPTIONS: undefined },
      });
    } finally { closeSync(slave); }
    exit = new Promise<void>(done => {
      child!.once('error', error => { spawnError = error; done(); });
      child!.once('exit', (code, signal) => { status = code ?? -osConstants.signals[signal!]; done(); });
    });
    const chunks: Buffer[] = [], buffer = Buffer.alloc(65536);
    let sent = 0, atPrompt: Row[] | null = null, promptTime: number | null = null;
    const answers = Array.isArray(config.answer) ? config.answer : [config.answer];
    while (performance.now() < deadline) {
      if (spawnError) throw spawnError;
      let bytes = 0, closed = false;
      try { bytes = readSync(fd, buffer, 0, buffer.length, null); closed = bytes === 0; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EIO') closed = true;
        else if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK' && code !== 'EINTR') throw error;
      }
      if (bytes) {
        chunks.push(Buffer.from(buffer.subarray(0, bytes)));
        const transcript = Buffer.concat(chunks).toString('utf8');
        const invitations = transcript.match(/\[Y\/n\]|Enter to start \/ Ctrl-C to cancel|Enter で始める \/ Ctrl-C でやめる|Press Enter to install \/ Ctrl-C to cancel|Enter で導入します \/ Ctrl-C でやめる|Press Enter to change \/ Ctrl-C to cancel|Enter で変更します \/ Ctrl-C でやめる/g)?.length ?? 0;
        if (invitations > sent && sent < answers.length) {
          if (!sent) { atPrompt = snapshot(config.home); promptTime = wallTime(); await detachTrace(); }
          writeSync(fd, { enter: '\r', yes: 'y', YES: 'Y', no: 'n', cancel: '\x03', eof: '\x04' }[answers[sent]!]!); sent++;
        }
      }
      if (closed || status !== null) break;
      await delay(bytes ? 0 : 10);
    }
    if (status === null) {
      const timeout = new AbortController();
      try { await Promise.race([exit, delay(Math.max(0, deadline - performance.now()), undefined, { signal: timeout.signal })]); }
      finally { timeout.abort(); }
      if (spawnError) throw spawnError;
      if (status === null) throw new Error('Packaged setup PTY watchdog expired');
    }
    const cliWrites = tracePrefix && sent ? beforeEnterWrites(promptTime!) : [];
    const allChanges = sent ? changes(before, atPrompt) : [], runtime = new Set(config.runtimeOwnedPaths ?? []), runtimeRoots = config.runtimeOwnedRoots ?? [];
    // Readonly SQLite may publish read marks and an empty WAL; committed WAL bytes stay protected.
    const families = ['alpacawork/.alpacawork/alpacawork.sqlite', 'alpacawork/.alpacawork/host.sqlite'];
    const emptyHash = createHash('sha256').update('').digest('hex');
    const sqliteReadChange = (change: Change) => families.some(base => change.path === base + '-shm' || change.path === base + '-wal' && [change.before, change.atPrompt].every(row => row === null || row[2] === emptyHash));
    const sqliteReads = allChanges.filter(sqliteReadChange), dataChanges = allChanges.filter(change => !sqliteReadChange(change));
    const beforeRows = new Map((before ?? []).map(row => [row[0], row])), promptRows = new Map((atPrompt ?? []).map(row => [row[0], row]));
    function runtimePublicationChange(change: Change) {
      if (!publisherScratch(basename(change.path))) return false;
      return (config.runtimeOwnedPublications ?? []).some(publication => {
        const canonical = beforeRows.get(publication);
        return dirname(change.path) === dirname(publication) && canonical !== undefined && JSON.stringify(canonical) === JSON.stringify(promptRows.get(publication)) && canonical[1] === (constants.S_IFREG | 0o600)
          && [change.before, change.atPrompt].every(row => row === null || JSON.stringify(row.slice(1)) === JSON.stringify(canonical.slice(1)));
      });
    }
    const publicationChanges = dataChanges.filter(runtimePublicationChange);
    const protectedChanges = dataChanges.filter(change => !runtime.has(change.path) && !runtimeRoots.some(root => within(change.path, root)) && !runtimePublicationChange(change));
    const result = { cliWriteTrace: { prefix: tracePrefix, tracerPid, stoppedBeforeEnter: tracerPid !== null && tracerFd === null }, cliBeforeEnterWrites: cliWrites,
      beforeEnterChanges: allChanges, protectedChanges, runtimePublicationChanges: publicationChanges, runtimeOwnedPaths: [...runtime].sort(comparePaths), runtimeOwnedRoots: runtimeRoots,
      baselineChanges, baselineStart, promptTime, cliPid: child.pid, status, transcript: Buffer.concat(chunks).toString('utf8'), prompt: sent > 0, confirmations: sent, sqliteReadChanges: sqliteReads,
      unchangedBeforeEnter: sent ? dataChanges.length === 0 : null };
    writeFileSync(config.output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    if (cliWrites.length) throw new Error('CLI wrote live runtime files before Enter: ' + JSON.stringify(cliWrites));
  } finally {
    try {
      if (tracerFd !== null && tracerFd >= 0) {
        try {
          const result = pidfd!.send(tracerFd, osConstants.signals.SIGTERM, null, 0);
          if (result !== 0 && koffi.errno() !== 3) throw new Error(`Cannot stop CLI tracer: errno ${koffi.errno()}`);
          await waitTracer();
        } finally { closeSync(tracerFd); }
      }
    } finally {
      closeSync(fd);
      if (child?.pid && status === null) {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        await exit;
      }
    }
  }
}
await main();
