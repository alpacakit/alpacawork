import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { shellQuote } from '../shell.js';
import type { HostAdapter } from './types.js';
import { createDefinition, definitionText, removeDefinition, validateService, type ServiceCommand, type ServiceDefinition } from './service-definition.js';
// ExecStart and Environment parse quoted words. WorkingDirectory parses one raw path.
const quoteWord = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
export function systemdDefinition(definition: ServiceDefinition): { path: string; text: string } {
  validateService(definition);
  const home = definition.environment.HOME!;
  const path = join(definition.environment.XDG_CONFIG_HOME || join(home, '.config'), 'systemd/user', definition.name);
  // A final slash also keeps a literal final backslash from becoming a line continuation.
  const directory = definition.workingDirectory.replace(/%/g, '%%') + '/';
  const text = `[Unit]\nDescription=alpacawork\n[Service]\nType=simple\nWorkingDirectory=${directory}\nExecStart=:${[definition.executable, ...definition.args].map(quoteWord).join(' ')}\n` +
    Object.entries(definition.environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `Environment=${quoteWord(key + '=' + value)}\n`).join('') +
    'Restart=on-failure\nKillMode=process\n[Install]\nWantedBy=default.target\n';
  return { path, text };
}
export function createSystemdService(command: ServiceCommand = (file, args) => spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })): HostAdapter['service'] {
  const run = (...args: string[]) => command('systemctl', ['--user', ...args]);
  const observe: HostAdapter['service']['observe'] = definition => {
    const native = systemdDefinition(definition);
    if (run('show-environment').status !== 0) return { state: 'unavailable', running: false, registrationStarts: false };
    const out = run('show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'LoadError', definition.name);
    // The manager answered above. Unit/query failures must keep their own cause.
    if (out.status !== 0) throw new Error(`Cannot inspect systemd user unit ${definition.name}: ${out.stderr?.trim() || out.stdout.trim() || 'systemctl show failed'}`);
    const fields = Object.fromEntries(out.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
    if (!['loaded', 'not-found'].includes(fields.LoadState ?? ''))
      throw new Error(`Cannot load systemd user unit ${definition.name} at ${fields.FragmentPath || native.path}: LoadState=${fields.LoadState || 'unknown'}${fields.LoadError ? `; ${fields.LoadError}` : ''}. Inspect it with systemctl --user status ${definition.name} and systemd-analyze --user verify ${shellQuote(native.path)}. After fixing the unit, run systemctl --user daemon-reload, then run setup again.`);
    const text = definitionText(native.path), running = !['inactive', 'failed', undefined].includes(fields.ActiveState);
    const state = text === null && fields.LoadState === 'not-found' ? 'absent' :
      text === native.text && (fields.LoadState === 'not-found' || fields.FragmentPath === native.path) ? 'matching' : 'conflict';
    return { state, running, registrationStarts: false };
  };
  return {
    observe,
    register(definition) {
      const state = observe(definition);
      if (!['absent', 'matching'].includes(state.state)) return false;
      const native = systemdDefinition(definition); if (state.state === 'absent') createDefinition(native.path, native.text);
      return run('daemon-reload').status === 0 && run('enable', native.path).status === 0;
    },
    unregister(definition) {
      const state = observe(definition);
      if (state.state !== 'matching' || state.running) return false;
      if (run('disable', definition.name).status !== 0) return false;
      const native = systemdDefinition(definition); removeDefinition(native.path, native.text);
      return run('daemon-reload').status === 0;
    },
    // A unit file alone reads as loaded; only an enabled unit is one the manager starts by itself.
    known: name => run('is-enabled', name).status === 0,
    stop(service) {
      if (typeof service !== 'string') { const state = observe(service); if (state.state === 'absent') return true; if (state.state !== 'matching') return false; }
      return run('stop', typeof service === 'string' ? service : service.name).status === 0;
    },
    start(definition) {
      return observe(definition).state === 'matching' && run('start', definition.name).status === 0;
    },
    restart(service) {
      if (typeof service !== 'string' && observe(service).state !== 'matching') return false;
      return run('restart', typeof service === 'string' ? service : service.name).status === 0;
    },
    restarts: name => Number(run('show', '-p', 'NRestarts', '--value', name).stdout.trim()) || 0,
  };
}
export const systemdService = createSystemdService();
