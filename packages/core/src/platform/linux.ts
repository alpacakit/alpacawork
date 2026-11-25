import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { HostAdapter } from './types.js';
import { linuxRun } from './linux-process.js';
import { systemdService } from './systemd-service.js';

export const linuxAdapter: HostAdapter = {
  posix: {
    libc: 'libc.so.6',
  },
  isSandboxed() {
    try {
      const status = readFileSync('/proc/self/status', 'utf8');
      const seccomp = /^Seccomp:[ \t]*(\d+)$/m.exec(status)?.[1];
      const noNewPrivs = /^NoNewPrivs:[ \t]*(\d+)$/m.exec(status)?.[1];
      const capabilities = /^CapEff:[ \t]*([0-9a-fA-F]+)$/m.exec(status)?.[1];
      // SELinux returns a NUL-terminated initial context before a policy is loaded.
      const rawProfile = readFileSync('/proc/self/attr/current', 'utf8');
      const profile = rawProfile.trim();
      const uidMap = readFileSync('/proc/self/uid_map', 'utf8').trim();
      const euid = process.geteuid?.();
      if (euid !== undefined && seccomp !== undefined && noNewPrivs !== undefined && capabilities && profile && uidMap)
        return euid === 0 || seccomp !== '0' || noNewPrivs !== '0' ||
          !/^0+$/.test(capabilities) || (profile !== 'unconfined' && rawProfile !== 'kernel\0') ||
          !/^0\s+0\s+4294967295$/.test(uidMap);
    } catch { /* An unknown isolation state cannot authorize run control. */ }
    throw new Error('Cannot determine whether the caller is sandboxed');
  },
  canDecodeImage(absolute) {
    try {
      execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-xerror', '-i', absolute, '-f', 'null', '-'],
        { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch { return false; }
  },
  folderDialog(start, title, env) {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    // GNOME's and KDE's own choosers; the first found on PATH is the one shown.
    const found = (name: string) => (env.PATH ?? '').split(delimiter).filter(Boolean).map(folder => join(folder, name)).find(path => {
      try { accessSync(path, constants.X_OK); return true; } catch { return false; }
    });
    // Both end with status 1 when closed, and also when they cannot reach the display ("Failed to open display",
    // "could not connect to display").
    const cancelled = (status: number | null, stderr: string) => status === 1 && !/\bdisplay\b/i.test(stderr);
    const zenity = found('zenity');
    if (zenity) return { command: zenity, args: ['--file-selection', '--directory', `--title=${title}`, `--filename=${start.replace(/\/*$/, '/')}`], cancelled };
    const kdialog = found('kdialog');
    if (kdialog) return { command: kdialog, args: ['--title', title, '--getexistingdirectory', start], cancelled };
    return null;
  },
  run: linuxRun,
  service: systemdService,
};
