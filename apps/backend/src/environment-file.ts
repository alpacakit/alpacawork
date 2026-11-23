/**
 * The user's environment file: how variables reach a server whose service definition is fixed and approved. `serve`
 * reads it once, as it starts, into its own environment, so every reader of that environment (the names an agent is
 * given, a provider's key, a switch) sees the file without knowing of it. Whoever starts `serve` gets the same rule.
 *
 * The file is `NAME=VALUE` lines; blank lines and lines starting with `#` are skipped. A value is taken as written, less
 * the spaces around it and one pair of quotes around all of it: no escapes, no `$` expansion, no `export`, no comment
 * after a value. What the file sets replaces what the server inherited.
 *
 * The file holds secrets, and a line put wrongly may hold one anywhere. So the report and the log carry nothing read
 * from it: only line numbers and reasons.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userConfigDirectory } from '@alpacawork/cli-kit';
import { environmentNameSchema } from '@alpacawork/contract/agent-environment';
import type { EnvironmentFile } from '@alpacawork/contract';

export function environmentFilePath(env: Readonly<Record<string, string | undefined>>): string {
  return join(userConfigDirectory(env), 'env');
}

/**
 * Names the file never sets. Where the server and its data are and which programs it finds (the service definition
 * pins these), how the Node processes it starts are loaded, and alpacawork's own names, which carry a Run's identity.
 * The switch that stops usage reporting is the one of alpacawork's names a person sets.
 */
const RESERVED_NAMES = ['HOME', 'PATH', 'NODE_OPTIONS', 'NODE_PATH'], RESERVED_PREFIXES = ['XDG_', 'ALPACAWORK_'];
const SETTABLE = 'ALPACAWORK_TELEMETRY_DISABLED';
const reserved = (name: string) => name !== SETTABLE && (RESERVED_NAMES.includes(name) || RESERVED_PREFIXES.some(prefix => name.startsWith(prefix)));

type Skipped = EnvironmentFile['skipped'];
/** A line either sets one variable or is skipped for a reason; one skipped line does not undo the others. */
function parse(text: string): { values: Map<string, string>; skipped: Skipped } {
  const values = new Map<string, string>(), skipped: Skipped = [];
  text.split('\n').forEach((written, index) => {
    const line = written.trim();
    if (line === '' || line.startsWith('#')) return;
    const at = line.indexOf('='), name = line.slice(0, Math.max(at, 0));
    const reason = at < 0 || line.includes('\0') || !environmentNameSchema.safeParse(name).success ? 'malformed'
      : reserved(name) ? 'reserved' : values.has(name) ? 'duplicate' : null;
    if (reason) skipped.push({ line: index + 1, reason });
    else values.set(name, line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/s, '$2'));
  });
  return { values, skipped };
}

/**
 * The file's text, or why there is none. Only a regular file of this user that no one else can read or write is read:
 * the facts are those of the opened file, so it cannot be swapped between the check and the read. The file itself may
 * not be a symbolic link; the folders above it may.
 */
function read(path: string): { state: 'read'; text: string } | { state: Exclude<EnvironmentFile['state'], 'read'> } {
  let file: number;
  try { file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === 'ENOENT' ? 'absent' : code === 'ELOOP' ? 'not_regular_file' : 'unreadable' };
  }
  try {
    const facts = fstatSync(file);
    if (!facts.isFile()) return { state: 'not_regular_file' };
    if (facts.uid !== process.getuid!()) return { state: 'owner' };
    if (facts.mode & 0o077) return { state: 'permissions' };
    return { state: 'read', text: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file)) };
  } catch { return { state: 'unreadable' }; }
  finally { closeSync(file); }
}

/** `serve --help` says the same rule. */
export const environmentFileHelp = 'Environment file: as it starts, serve reads NAME=VALUE lines from ${XDG_CONFIG_HOME:-~/.config}/alpacawork/env ' +
  'into its environment, replacing what it inherited. It must be a regular file of this user that no one else can read or write (chmod 600), ' +
  `or none of it is read. ${[...RESERVED_NAMES, ...RESERVED_PREFIXES.map(prefix => `${prefix}*`)].join(', ')} (except ${SETTABLE}) are never set from it. ` +
  'Settings > AI shows what was read; a line that set nothing is logged to stderr by its number.';

/** Sets the file's variables in `env` and says what was done. No file sets nothing and is no problem. */
export function applyEnvironmentFile(env: NodeJS.ProcessEnv): EnvironmentFile {
  const path = environmentFilePath(env), file = read(path);
  if (file.state !== 'read') return { path, state: file.state, applied: 0, skipped: [] };
  const { values, skipped } = parse(file.text);
  for (const [name, value] of values) env[name] = value;
  return { path, state: 'read', applied: values.size, skipped };
}

/** What a server that read no file says of it: the same as one whose file is absent. */
export function unreadEnvironmentFile(env: Readonly<Record<string, string | undefined>>): EnvironmentFile {
  return { path: environmentFilePath(env), state: 'absent', applied: 0, skipped: [] };
}

/** The lines for the server's log when the file did not do all it says; none when it did, or there is no file. */
export function environmentFileProblems(file: EnvironmentFile): string[] {
  if (file.state !== 'read' && file.state !== 'absent') return [`Environment file ${file.path} was not read (${file.state}); none of it is set`];
  return file.skipped.map(each => `Environment file ${file.path} line ${each.line} was skipped (${each.reason})`);
}
