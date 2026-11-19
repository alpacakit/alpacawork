import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostAdapter } from './types.js';
import { createDefinition, definitionText, removeDefinition, validateService, type ServiceCommand, type ServiceDefinition } from './service-definition.js';
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function launchdDefinition(definition: ServiceDefinition): { path: string; text: string } {
  validateService(definition);
  const path = join(definition.environment.HOME!, 'Library/LaunchAgents', definition.name + '.plist');
  const text = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>' +
    `<key>Label</key><string>${xml(definition.name)}</string><key>ProgramArguments</key><array>` + [definition.executable, ...definition.args].map(value => `<string>${xml(value)}</string>`).join('') +
    `</array><key>WorkingDirectory</key><string>${xml(definition.workingDirectory)}</string><key>EnvironmentVariables</key><dict>` + Object.entries(definition.environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('') +
    '</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>\n';
  return { path, text };
}
/** Only root fields of launchctl print identify this job; path text and nested jobs do not. */
function jobFields(text: string): { path?: string; pid?: string } | null {
  const lines = text.split('\n');
  const outer = lines.find(line => line.trim())?.trim().endsWith(' = {') ? 1 : 0;
  let depth = 0; const fields: Record<string, string> = {};
  for (const line of lines) {
    const value = line.trim();
    if (depth === outer) {
      const match = /^(path|pid) = (.*)$/.exec(value);
      if (match) { if (match[1]! in fields) return null; fields[match[1]!] = match[2]!; }
    }
    if (value.endsWith(' = {')) depth++;
    else if (value === '}') depth--;
  }
  if (depth !== 0 || fields.pid !== undefined && (!/^[1-9][0-9]*$/.test(fields.pid) || !Number.isSafeInteger(Number(fields.pid)))) return null;
  return fields;
}
export function createLaunchdService(command: ServiceCommand = (file, args) => spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })): HostAdapter['service'] {
  const domain = `gui/${process.getuid!()}`, target = (name: string) => `${domain}/${name}`;
  const run = (...args: string[]) => command('launchctl', args);
  const missing = (out: ReturnType<ServiceCommand>) => out.status === 113 && /Could not find service/.test(out.stderr ?? '');
  const observe: HostAdapter['service']['observe'] = definition => {
    const native = launchdDefinition(definition);
    if (run('print', domain).status !== 0) return { state: 'unavailable', running: false, registrationStarts: true };
    const out = run('print', target(definition.name)), text = definitionText(native.path);
    if (out.status !== 0 && !missing(out)) return { state: 'unavailable', running: false, registrationStarts: true };
    const fields = out.status === 0 ? jobFields(out.stdout) : jobFields('');
    if (!fields) return { state: 'unavailable', running: false, registrationStarts: true };
    const state = text === null && missing(out) ? 'absent' : text === native.text &&
      (missing(out) || fields.path === native.path) ? 'matching' : 'conflict';
    return { state, running: out.status === 0 && fields.pid !== undefined, registrationStarts: true };
  };
  const stop: HostAdapter['service']['stop'] = service => {
    // A name has no recoverable native definition: preserve the earlier unsupported stop boundary.
    if (typeof service === 'string') return false;
    const state = observe(service); if (state.state === 'absent') return true; if (state.state !== 'matching') return false;
    const name = service.name;
    const before = run('print', target(name));
    if (before.status !== 0) return missing(before) && run('print', domain).status === 0;
    const fields = jobFields(before.stdout); if (!fields || fields.path !== launchdDefinition(service).path) return false;
    const pid = fields.pid;
    const identity = () => {
      const out = command('ps', ['-p', pid!, '-o', 'lstart=']);
      if (out.status === 0 && out.stdout.trim()) return { state: 'running' as const, start: out.stdout.trim() };
      if (out.status === 1 && !out.stdout.trim() && !(out.stderr ?? '').trim()) return { state: 'absent' as const };
      return { state: 'unavailable' as const };
    };
    const beforeProcess = pid ? identity() : null;
    if (beforeProcess?.state === 'unavailable') return false;
    if (run('bootout', target(name)).status !== 0) return false;
    // Removal from launchd alone is not proof that the old process ended.
    for (let n = 0; n < 100; n++) {
      const state = run('print', target(name));
      if (state.status !== 0 && !missing(state)) return false;
      if (missing(state)) {
        if (run('print', domain).status !== 0) return false;
        const afterProcess = pid ? identity() : null;
        if (afterProcess?.state === 'unavailable') return false;
        if (!afterProcess || afterProcess.state === 'absent' || beforeProcess?.state === 'running' && afterProcess.start !== beforeProcess.start) return true;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return false;
  };
  return {
    observe,
    register(definition) {
      const state = observe(definition), native = launchdDefinition(definition);
      if (!['absent', 'matching'].includes(state.state)) return false;
      if (state.state === 'absent') createDefinition(native.path, native.text);
      const current = run('print', target(definition.name));
      if (current.status === 0) return true;
      return missing(current) && run('bootstrap', domain, native.path).status === 0;
    },
    unregister(definition) {
      if (observe(definition).state !== 'matching' || !stop(definition)) return false;
      const native = launchdDefinition(definition); removeDefinition(native.path, native.text); return true;
    },
    known: name => run('print', target(name)).status === 0,
    stop,
    restart(service) {
      if (typeof service !== 'string') {
        if (observe(service).state !== 'matching') return false;
        const current = run('print', target(service.name));
        if (current.status !== 0 && (!missing(current) || run('bootstrap', domain, launchdDefinition(service).path).status !== 0)) return false;
      }
      return run('kickstart', '-k', target(typeof service === 'string' ? service : service.name)).status === 0;
    },
    restarts: () => 0,
  };
}
export const launchdService = createLaunchdService();
