/** Opening a URL in the browser of the person at this terminal: one launcher per platform, shared by setup and `alpacawork open`. */
import { spawn } from 'node:child_process';

/** Why no browser was opened: `remote` over SSH (the browser is on another PC), `no-browser` when this host has none to start. */
export type BrowserOutcome = 'opened' | 'remote' | 'no-browser';
type Launch = (command: string, args: string[]) => Promise<void>;

/** The launcher for this host, or null when it has no desktop to show a browser on. WSL hands the URL to Windows. */
export function browserLauncher(env: Readonly<NodeJS.ProcessEnv>, platform: string = process.platform): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform !== 'linux') return null;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler'] };
  return env.DISPLAY || env.WAYLAND_DISPLAY ? { command: 'xdg-open', args: [] } : null;
}

const spawnLauncher = (env: Readonly<NodeJS.ProcessEnv>): Launch => (command, args) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: 'ignore', detached: true, shell: false });
  const timeout = setTimeout(() => reject(new Error('Browser launcher did not finish')), 5_000);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('spawn', () => child.unref());
  child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Browser launcher failed')); });
});

export async function openBrowser(url: string, env: Readonly<NodeJS.ProcessEnv>, options: { platform?: string; launch?: Launch } = {}): Promise<BrowserOutcome> {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return 'remote';
  const launcher = browserLauncher(env, options.platform);
  if (!launcher) return 'no-browser';
  try { await (options.launch ?? spawnLauncher(env))(launcher.command, [...launcher.args, url]); return 'opened'; }
  catch { return 'no-browser'; }
}
