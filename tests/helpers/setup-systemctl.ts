/** Fake systemd command. The real adapter owns definition text and registration decisions. */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** The copied executable uses this Node and an absolute module URL, independently of fixture PATH. */
export function installSetupSystemctl(destination: string, options: { nodeImports?: string[] } = {}) {
  writeFileSync(destination, `#!${process.execPath}\nimport { runSystemctl } from ${JSON.stringify(import.meta.url)};\nawait runSystemctl(${JSON.stringify(options)});\n`, { mode: 0o700 });
}

// POSIX shlex.split semantics used by the old fixture for systemd's quoted words.
function splitWords(text: string) {
  const words: string[] = []; let word = '', quote = '', active = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote === "'") { if (char === quote) quote = ''; else word += char; }
    else if (char === quote && quote) quote = '';
    else if (char === '\\' && quote !== "'") {
      const next = text[++i]; if (next === undefined) throw new Error('No escaped character');
      word += quote === '"' && next !== '"' && next !== '\\' ? '\\' + next : next; active = true;
    } else if (!quote && (char === '"' || char === "'")) { quote = char; active = true; }
    else if (!quote && /[ \t\r\n]/.test(char)) { if (active) { words.push(word); word = ''; active = false; } }
    else { word += char; active = true; }
  }
  if (quote) throw new Error('No closing quotation');
  if (active) words.push(word);
  return words;
}

export async function runSystemctl(options: { nodeImports?: string[] } = {}) {
  const home = process.env.HOME!, state = join(home, 'fake-manager'), unit = join(process.env.XDG_CONFIG_HOME!, 'systemd/user/alpacawork.service');
  const args = process.argv.slice(2); if (args[0] === '--user') args.shift();
  function identity(pid: number) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      return fields[0] === 'Z' || fields[0] === 'X' ? null : fields[19]!;
    } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code!)) return null; throw error; }
  }
  function current(): { pid: number; start: string } | null {
    const file = join(state, 'pid.json'); if (!existsSync(file)) return null;
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isInteger(saved.pid) || saved.pid <= 1 || typeof saved.start !== 'string' || !/^\d+$/.test(saved.start)) throw new Error('Invalid fake managed backend identity');
    return identity(saved.pid) === saved.start ? saved : null;
  }
  async function stop(signal: NodeJS.Signals = 'SIGTERM') {
    const saved = current(); if (!saved) return;
    try { process.kill(saved.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH' || current()) throw error; return; }
    for (let i = 0; i < 500; i++) { if (!current()) return; await delay(10); }
    throw new Error('Fake managed backend did not stop: ' + JSON.stringify({ expected: saved, current: current(), signal }));
  }
  const done = (status = 0) => { process.exitCode = status; };
  if (existsSync(join(home, 'manager-unavailable'))) return done(1);
  if (args[0] === 'show-environment') return done();
  if (args[0] === 'status') { console.log(current() ? 'active' : 'inactive'); return done(current() ? 0 : 3); }
  if (args[0] === 'show') {
    if (args.includes('NRestarts')) console.log(existsSync(join(state, 'pid.json')) && !current() ? 1 : 0);
    else {
      // As systemd does: a unit file on disk reads as loaded, and a removed one stays held until the next daemon-reload.
      const invalid = existsSync(join(home, 'unit-bad-setting')), loaded = existsSync(unit) || existsSync(join(state, 'held'));
      console.log('LoadState=' + (invalid ? 'bad-setting' : loaded ? 'loaded' : 'not-found'));
      if (invalid) console.log('LoadError=org.freedesktop.systemd1.BadUnitSetting "invalid WorkingDirectory"');
      console.log('ActiveState=' + (current() ? 'active' : 'inactive'));
      if (args.includes('DropInPaths')) console.log('DropInPaths=');
      console.log('FragmentPath=' + (loaded ? unit : ''));
    }
    return done();
  }
  // Enablement is its own fact: only `enable` makes the manager start the unit by itself.
  if (args[0] === 'is-enabled') { const enabled = existsSync(unit) && existsSync(join(state, 'enabled')); console.log(enabled ? 'enabled' : 'disabled'); return done(enabled ? 0 : 1); }
  mkdirSync(state, { mode: 0o700, recursive: true });
  const mark = (name: string, present: boolean) => {
    if (present) closeSync(openSync(join(state, name), 'a', 0o600));
    else try { unlinkSync(join(state, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  if (args[0] === 'daemon-reload') { mark('held', existsSync(unit)); return done(); }
  if (args[0] === 'enable') {
    if (existsSync(join(home, 'fail-register'))) return done(1);
    mark('held', true); mark('enabled', true); return done();
  }
  if (args[0] === 'disable') { mark('enabled', false); return done(); }
  if (args[0] === 'stop' || args[0] === 'kill') { await stop(args[0] === 'kill' ? 'SIGKILL' : 'SIGTERM'); return done(); }
  if (args[0] === 'restart' || args[0] === 'start') {
    if (args[0] === 'start' && current()) return done();
    if (args[0] === 'restart') await stop();
    if (existsSync(join(home, 'fail-start'))) return done(1);
    let command: string[] | undefined, cwd: string | undefined; const env = { ...process.env };
    for (const line of readFileSync(unit, 'utf8').split(/\r?\n/)) {
      if (line.startsWith('Environment=')) {
        const value = splitWords(line.slice('Environment='.length))[0]!, equals = value.indexOf('=');
        env[value.slice(0, equals)] = value.slice(equals + 1).replaceAll('%%', '%');
      } else if (line.startsWith('ExecStart=:')) command = splitWords(line.slice('ExecStart=:'.length)).map(word => word.replaceAll('%%', '%'));
      else if (line.startsWith('WorkingDirectory=')) cwd = line.slice('WorkingDirectory='.length).replaceAll('%%', '%');
    }
    for (const key of ['ALPACAWORK_RUN', 'ALPACAWORK_RUN_TOKEN', 'ALPACAWORK_RUNTIME_LEASE_FD', 'NODE_OPTIONS']) delete env[key];
    if (!command?.length || !cwd) throw new Error('Fake managed backend definition lacks command or working directory');
    if (options.nodeImports?.length) command = [command[0]!, ...options.nodeImports.flatMap(path => ['--import', path]), ...command.slice(1)];
    if (process.env.PUBLIC_SETUP_TRACE_BACKEND) command = ['strace', '-D', '-ff', '-ttt', '-yy', '-e', 'trace=openat,write,pwrite64,mmap,rename,unlink,chmod', '-e', 'raw=write,pwrite64', '-o', process.env.PUBLIC_SETUP_TRACE_BACKEND, ...command];
    const log = openSync(join(state, 'backend.log'), 'a');
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: ['ignore', log, log], detached: true }); }
    finally { closeSync(log); }
    await new Promise<void>((done, reject) => { child.once('error', reject); child.once('spawn', done); });
    child.unref();
    const started = identity(child.pid!);
    if (started === null) throw new Error('Fake managed backend exited before its identity was recorded');
    writeFileSync(join(state, 'pid.json'), JSON.stringify({ pid: child.pid, start: started }));
    return done();
  }
  throw new Error('Unexpected fake systemctl operation: ' + JSON.stringify(args));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runSystemctl();
