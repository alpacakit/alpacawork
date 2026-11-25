/**
 * Claude Code's record of a conversation: `<config>/projects/<folder>/<session>.jsonl`, and a file for each sub-agent the
 * conversation ran under `<config>/projects/<folder>/<session>/subagents/`. Each line is a message with its `timestamp`;
 * an assistant message's `tool_use` block starts a call and a later `tool_result` block naming its `tool_use_id` ends it.
 * The IDs are those the Run's output (stream-json) names its steps with.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRecord, recordLines, recordTime, type ConversationCalls } from './calls.js';

export class ClaudeTranscripts {
  private folders: string[] | null = null;
  private readonly read = new Map<string, Promise<ConversationCalls>>();

  /** `config`: Claude Code's configuration folder (CLAUDE_CONFIG_DIR, else ~/.claude). */
  constructor(private readonly config: string) {}

  /** Conversation `session`'s calls, read once however many Runs share it. */
  calls(session: string): Promise<ConversationCalls> {
    let held = this.read.get(session);
    if (!held) this.read.set(session, held = this.readSession(session));
    return held;
  }

  private files(session: string): string[] {
    if (!/^[\w-]+$/.test(session)) return [];
    const projects = join(this.config, 'projects');
    this.folders ??= existsSync(projects) ? readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(projects, entry.name)) : [];
    return this.folders.flatMap(folder => {
      const main = join(folder, `${session}.jsonl`), subagents = join(folder, session, 'subagents');
      let agents: string[] = [];
      try { agents = readdirSync(subagents).filter(name => name.endsWith('.jsonl')).sort().map(name => join(subagents, name)); } catch { /* none */ }
      return [...existsSync(main) ? [main] : [], ...agents];
    });
  }

  private async readSession(session: string): Promise<ConversationCalls> {
    const files = this.files(session);
    return readRecord(files, async book => { for (const file of files) for await (const line of recordLines(file)) {
      const at = recordTime(line.timestamp), message = line.message;
      const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined;
      if (!at || !Array.isArray(content)) continue;
      book.entries++;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const { type, id, tool_use_id: ended } = block as { type?: unknown; id?: unknown; tool_use_id?: unknown };
        if (type === 'tool_use') book.started(id, at);
        else if (type === 'tool_result') book.ended(ended, at);
      }
    } });
  }
}
