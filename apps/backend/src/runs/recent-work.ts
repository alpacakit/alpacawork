/** One bounded display projection of stdout work. Names describe recent work, never tool liveness. */
import { RUN_FILES, workLabelSchema, type WorkLabel, type WorkName, type WorkCommand, type RunStepKind } from '@alpacawork/contract/run';
import { optionalRunFile, readRunFile } from './files.js';

const PAUSE_MS = 6_000;
const tools = new Map<string, RunStepKind>(Object.entries({
  bash: 'command', powershell: 'command', shell: 'command', command_execution: 'command',
  read: 'file', read_file: 'file', view: 'file', image_view: 'file',
  grep: 'search', glob: 'search', find: 'search', ls: 'search', grep_search: 'search', list_files: 'search',
  edit: 'edit', write: 'edit', notebookedit: 'edit', apply_patch: 'edit', create: 'edit',
  edit_file: 'edit', write_file: 'edit', file_change: 'edit',
  websearch: 'web', webfetch: 'web', web_search: 'web', web_fetch: 'web', x_search: 'web',
} satisfies Record<string, RunStepKind>));

export function runStepKind(tool: string, fallback: string, command: WorkCommand | null): RunStepKind {
  return command ? 'command' : tools.get(tool.toLowerCase()) ?? tools.get(fallback.toLowerCase()) ?? 'tool';
}

export function recentWorkName(kind: RunStepKind, command: WorkCommand | null): WorkName {
  if (command === 'task.list' || command === 'task.returns') return 'task.get';
  return command ?? kind;
}
/** Groups started work into episodes; the screen alone owns how long a displayed label stays. */
export class RecentWork {
  private readonly active = new Set<string>();
  private latest: WorkLabel | null = null;
  private quietAt = 0;
  get label(): WorkLabel | null { return this.latest; }

  start(id: string, name: WorkName, at: number): void {
    const continues = this.latest?.name === name && (this.active.size > 0 || at - this.quietAt < PAUSE_MS);
    this.latest = { name, count: continues ? this.latest!.count + 1 : 1 };
    this.active.add(id);
  }
  end(id: string, at: number): void {
    if (!this.active.delete(id)) { this.reset(); return; }
    if (!this.active.size) this.quietAt = at;
  }
  reset(): void {
    this.active.clear(); this.latest = null;
  }
  advance(at: number): void {
    if (!this.active.size && at - this.quietAt >= PAUSE_MS) this.latest = null;
  }
}

export function readRecentWork(folder: string): WorkLabel | null {
  const bytes = optionalRunFile(() => readRunFile(folder, RUN_FILES.recentWork, 256));
  if (!bytes) return null;
  try {
    const parsed = workLabelSchema.nullable().safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
