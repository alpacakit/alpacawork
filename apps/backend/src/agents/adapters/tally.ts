import { z } from 'zod';
import { simpleInvocations } from '../../runs/shell-command.js';
import { object } from './output.js';

export const TALLY_VERSION = 2;
const name = z.string().regex(/^[A-Za-z0-9_.:/@+ -]{1,160}$/);
const count = z.number().int().nonnegative();
export const tallySchema = z.strictObject({
  v: z.literal(TALLY_VERSION), provider: name, model: name.nullable(),
  tools: z.record(name, count), mcp: z.record(name, count),
  skills: z.record(name, z.strictObject({ call: count, read: count })),
  subagentTools: count, state: z.enum(['complete', 'partial', 'unsupported']),
});
export type Tally = z.infer<typeof tallySchema>;

const bridgeProviders = new Set(['codex', 'pi', 'copilot', 'grok']);
export const supportsTally = (adapter: string) => adapter === 'claude' || bridgeProviders.has(adapter);
const nonTools = new Set(['agent_message', 'user_message', 'reasoning', 'error', 'agent_configuration', 'context_compaction', 'plan', 'plan_update']);
const readVerbs = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'more', 'wc', 'grep', 'rg', 'awk', 'bat']);
const safeName = (value: unknown) => typeof value === 'string' && name.safeParse(value).success ? value : null;
const skillPathName = (path: string) => /(?:^|\/)skills\/([A-Za-z0-9_.-]+)\/(?:SKILL\.md|references\/[A-Za-z0-9_./-]+\.md)$/.exec(path)?.[1];
function editsInPlace(args: (string | null)[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (!arg) continue;
    if (/^(?:--in-place(?:=|$)|-[^-efli]*i)/.test(arg)) return true;
    // The next word is an option argument for these flags when no value is attached.
    if (/^(?:--(?:expression|file|line-length)|-[^-efli]*[efl])$/.test(arg)) index++;
  }
  return false;
}

function skillReads(command: unknown) {
  const skills = new Set<string>();
  for (const [program, ...args] of simpleInvocations(command)) {
    const verb = program?.split('/').at(-1);
    if (!verb || !readVerbs.has(verb) || verb === 'sed' && editsInPlace(args)) continue;
    for (const arg of args) {
      const skill = arg && skillPathName(arg);
      if (skill) skills.add(skill);
    }
  }
  return skills;
}
const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
function mcpKey(name: string) {
  const [prefix, server, ...tool] = name.split('__');
  return prefix === 'mcp' && server && tool.length ? `${server}:${tool.join('__')}` : null;
}
type Evidence = { type: string; child?: boolean; tool?: string; mcp?: string; called?: string; read: Set<string> };

export class TallyParser {
  private readonly items = new Map<string, Evidence>();
  private model: string | null = null;
  private partial = false;
  constructor(private readonly adapter: string, private readonly provider: string, private readonly session: string | null) {}

  observe(value: unknown) {
    if (!supportsTally(this.adapter)) return;
    const row = object(value);
    if (this.session && typeof row.session_id === 'string' && row.session_id !== this.session && !row.parent_tool_use_id) return;
    if (this.adapter === 'claude') {
      if (row.type === 'system' && row.subtype === 'init') this.model ??= safeName(row.model);
      if (row.type !== 'assistant') return;
      const content = object(row.message).content;
      if (!Array.isArray(content)) return;
      for (const value of content) {
        const block = object(value), tool = safeName(block.name);
        if (block.type !== 'tool_use' || !tool) continue;
        const input = object(block.input), called = safeName(input.skill);
        const path = typeof input.file_path === 'string' ? skillPathName(input.file_path) : null;
        this.keep(block.id, { type: tool, child: !!row.parent_tool_use_id, tool, mcp: safeName(mcpKey(tool)) ?? undefined,
          called: tool === 'Skill' ? called ?? undefined : undefined,
          read: tool === 'Bash' ? skillReads(input.command) : new Set(tool === 'Read' && path ? [path] : []) });
      }
      return;
    }
    const item = object(row.item);
    if (row.type !== 'item.started' && row.type !== 'item.completed') return;
    if (item.type === 'agent_configuration') this.model ??= safeName(item.model);
    const type = safeName(item.type);
    if (!type || nonTools.has(type)) return;
    const server = safeName(item.server), operation = safeName(item.tool) ?? safeName(item.name);
    const qualified = server && operation ? `${server}:${operation}` : operation && (mcpKey(operation) ?? `unknown:${operation}`);
    const mcp = type === 'mcp_tool_call' ? safeName(qualified) ?? 'unknown:unknown' : undefined;
    this.keep(item.id, { type, tool: type, child: !!row.parent_tool_use_id || !!item.parent_tool_use_id, mcp,
      read: type === 'command_execution' ? skillReads(item.command) : new Set() });
  }

  private keep(id: unknown, item: Evidence) {
    if (typeof id !== 'string' || !id || id.length > 256) { this.partial = true; return; }
    const prior = this.items.get(id);
    if (!prior) {
      if (this.items.size >= 65_536) this.partial = true;
      else this.items.set(id, item);
      return;
    }
    if (prior.type !== item.type) { this.partial = true; return; }
    if ((!prior.mcp || prior.mcp.startsWith('unknown:')) && item.mcp && item.mcp !== 'unknown:unknown') prior.mcp = item.mcp;
    prior.called ??= item.called;
    prior.child ||= item.child;
    for (const name of item.read) prior.read.add(name);
  }

  finish(state: Tally['state']): Tally {
    const tools: Tally['tools'] = Object.create(null), mcp: Tally['mcp'] = Object.create(null);
    const skills: Tally['skills'] = Object.create(null);
    let subagentTools = 0;
    for (const item of this.items.values()) {
      if (item.child) { subagentTools++; continue; }
      if (item.mcp) bump(mcp, item.mcp);
      else if (item.tool) bump(tools, item.tool);
      if (item.called) (skills[item.called] ??= { call: 0, read: 0 }).call++;
      for (const skill of item.read) (skills[skill] ??= { call: 0, read: 0 }).read++;
    }
    return { v: TALLY_VERSION, provider: safeName(this.provider) ?? 'unknown', model: this.model, tools, mcp, skills,
      subagentTools, state: state === 'complete' && this.partial ? 'partial' : state };
  }
}
