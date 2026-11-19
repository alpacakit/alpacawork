import { parseLaunchOptions } from '@alpacawork/contract/launch-options';
import type { BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import type { CatalogInput } from '../../coordinator/skill-catalog/context.js';
import { CatalogUnavailable } from '../../coordinator/skill-catalog/files.js';
import type { SkillCatalogContext } from './types.js';
/** Only launch options demonstrated not to change discovery are accepted. Unknown flags never disappear. */
export function catalogContext(id: BuiltinAdapterId, input: Pick<CatalogInput, 'argv' | 'env' | 'session'>): SkillCatalogContext {
  if (id !== 'claude' && id !== 'codex') throw new CatalogUnavailable('launch');
  const codex = id === 'codex';
  if (Object.entries(input.env).some(([name, value]) => value && /^(?:CLAUDE_CODE_.*(?:SKILL|PLUGIN|SIMPLE|SAFE_MODE)|CODEX_.*(?:SKILL|PLUGIN))$/.test(name)))
    throw new CatalogUnavailable('launch');
  const values = new Set(codex ? ['--command', '-m', '--model', '-s', '--sandbox', '-o', '--output-last-message'] : ['-m', '--model', '--effort', '--session-id', '--resume', '--input-format', '--output-format', '--permission-mode', '--permission-prompts']);
  const flags = new Set(codex ? ['--skip-git-repo-check', '--json', 'resume'] : ['-p', '--print', '--verbose', '--no-session-persistence', '--dangerously-skip-permissions']);
  // Claude's tool lists restrict what a turn may do, not what it finds; each takes every value up to the next option.
  const lists = new Set(codex ? [] : ['--tools', '--allowedTools', '--disallowedTools']);
  for (let at = codex ? 2 : 1; at < input.argv.length; at++) {
    const arg = input.argv[at]!;
    if (codex && (arg === '-c' || arg === '--config')) {
      // These existing coordinator presentation overrides do not affect skill discovery.
      const value = input.argv[++at] ?? '';
      const split = value.indexOf('=');
      if (!['model_reasoning_effort', 'service_tier', 'model_verbosity'].includes(value.slice(0, split)))
        throw new CatalogUnavailable('launch');
      try {
        const ast = parseLaunchOptions(value.slice(split + 1));
        const node = ast.length === 1 ? ast[0] : undefined;
        const part = node?.kind === 'word' && node.parts.length === 1 ? node.parts[0] : undefined;
        if (!part || !(part.kind === 'literal' && /^[a-z_]+$/.test(part.value))) throw new CatalogUnavailable('launch');
      } catch { throw new CatalogUnavailable('launch'); }
    }
    else if (values.has(arg)) { if (!input.argv[++at]) throw new CatalogUnavailable('launch'); }
    else if (lists.has(arg)) {
      const items: string[] = [];
      while (at + 1 < input.argv.length && !input.argv[at + 1]!.startsWith('-')) items.push(input.argv[++at]!);
      if (!items.length) throw new CatalogUnavailable('launch');
      // A skill is invoked with Skill and read with Read: without either, a turn can use none.
      const tools = items.flatMap(item => item.split(/[\s,]+/)).filter(Boolean);
      if (arg === '--tools' && !tools.includes('default') && !(tools.includes('Skill') && tools.includes('Read')))
        throw new CatalogUnavailable('launch');
    }
    // A final positional session cannot change discovery, including before its ID is observed.
    else if (codex && arg === '--' && at === input.argv.length - 2) at++;
    else if (!flags.has(arg)) throw new CatalogUnavailable('launch');
  }
  return { kind: id, env: input.env, session: input.session };
}
