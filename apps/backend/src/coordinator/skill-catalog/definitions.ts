import { parseDocument } from 'yaml';
import { basename, dirname, join, relative } from 'node:path';
import { Files, CatalogUnavailable } from './files.js';
export type Definition = { name: string; description: string; path: string; source: string; invocable: boolean };
class InvalidDefinition extends Error {}
/**
 * What the CLI cannot read is absent to it, and to the catalog: the skills beside it stay, and a namesake further down
 * takes its place. tests/fixtures/skill-catalog-contrast.mjs holds this and `definition` against both real CLIs.
 */
async function entry<T>(read: () => Promise<T | null>): Promise<T | null> {
  try { return await read(); } catch (error) {
    if (error instanceof InvalidDefinition || error instanceof CatalogUnavailable && error.reason === 'unreadable') return null;
    throw error;
  }
}
/** Like both CLIs, quotes a plain value YAML would otherwise refuse and tries once more; a header past that is not repaired. */
const quoteValues = (source: string) => source.split(/\r?\n/).map(line => {
  const found = /^([A-Za-z_-]+):\s+(.+)$/.exec(line);
  return found && !/^["']/.test(found[2]!) && /[{}[\]*&#!|>%@`]|: /.test(found[2]!) ? `${found[1]}: ${JSON.stringify(found[2]!.trimEnd())}` : line;
}).join('\n');
function parsed(source: string, uniqueKeys: boolean): Record<string, unknown> | null {
  const yaml = parseDocument(source, { uniqueKeys });
  if (yaml.errors.length || yaml.warnings.length) return null;
  try {
    const value: unknown = yaml.toJS({ maxAliasCount: 50 });
    return value === null ? {} : typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
/** The fence and header as each CLI takes them. Null attrs: there is a fence, and no header it can read. */
function header(text: string, kind: 'claude' | 'codex' | 'command') {
  const codex = kind === 'codex';
  const fence = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(codex ? text : text.replace(/^\uFEFF/, ''));
  if (!fence) return { attrs: null, body: text };
  const source = fence[1] ?? '';
  return { attrs: parsed(source, codex) ?? parsed(quoteValues(source), codex), body: text.slice(fence.index + fence[0].length) };
}
const said = (value: unknown) => {
  const words = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).replace(/\s+/g, ' ').trim() : '';
  return words || undefined;
};
const firstLine = (body: string) => said(body.split(/\r?\n/).find(line => line.trim() && line.trim() !== '---')?.replace(/^#+\s*/, ''));
/** A name a message can carry as one word; another stays in its place in the order, not offered. */
const MENTIONABLE = /^[\p{L}\p{N}_][\p{L}\p{N}_:.-]*$/u;
export async function definition(files: Files, path: string, fallback: string, source: string, kind: 'claude' | 'codex' | 'command' = 'claude'): Promise<Definition> {
  const { attrs: read, body } = header(await files.head(path), kind);
  // Codex refuses what it cannot read; Claude takes the folder's name and the first line of the text.
  if (kind === 'codex' && !said(read?.description)) throw new InvalidDefinition();
  const attrs = read ?? {};
  const name = kind === 'command' ? fallback : said(attrs.name) ?? fallback;
  if (kind === 'codex' && name.length > 64) throw new InvalidDefinition();
  const description = said(attrs.description) ?? firstLine(body) ?? '';
  // Codex ignores Claude's flags. A hidden definition still holds its name against a project namesake.
  const listed = attrs['user-invocable'] === undefined || [true, 'true', 'yes'].includes(attrs['user-invocable'] as never);
  const shown = kind === 'codex' || listed && ![true, 'true'].includes(attrs['disable-model-invocation'] as never);
  return { invocable: shown && MENTIONABLE.test(name), name, description, path: await files.canonical(path), source };
}
/** Claude skills are immediate child directories; legacy commands recurse and use colon namespaces. */
export async function claudeDefinitions(files: Files, root: string, commands: boolean, source: string): Promise<Definition[]> {
  const result: Definition[] = [];
  const walk = async (folder: string, ancestors: Set<string>) => {
    const canonical = await files.kind(folder) ? await files.canonical(folder) : null;
    if (!canonical) return;
    if (ancestors.has(canonical)) return;
    const chain = new Set([...ancestors, canonical]);
    for (const name of await files.children(folder)) {
      if (name.startsWith('.')) continue;
      const path = join(folder, name);
      const parsed = await entry(async () => {
        const kind = await files.kind(path);
        if (commands && kind === 'directory') { if (chain.size > 32) throw new CatalogUnavailable('limit'); await walk(path, chain); return null; }
        const file = commands ? name.endsWith('.md') && kind === 'file' ? path : null : kind === 'directory' && await files.kind(join(path, 'SKILL.md')) ? join(path, 'SKILL.md') : null;
        return file && definition(files, file, commands ? relative(root, path).replace(/\.md$/, '').split(/[\\/]/).join(':') : name, source, commands ? 'command' : 'claude');
      });
      if (parsed) result.push(parsed);
    }
  };
  await walk(root, new Set()); return result;
}
export async function codexDefinitions(files: Files, root: string, source: string): Promise<Definition[]> {
  const result: Definition[] = [];
  const walk = async (folder: string, ancestors: Set<string>) => {
    if (!await files.kind(folder)) return;
    const canonical = await files.canonical(folder);
    if (ancestors.has(canonical)) return;
    if (ancestors.size > 32) throw new CatalogUnavailable('limit');
    const file = join(folder, 'SKILL.md');
    if (await entry(() => files.kind(file))) {
      const parsed = await entry(() => definition(files, file, basename(dirname(file)), source, 'codex'));
      if (parsed) result.push(parsed);
      return;
    }
    const chain = new Set([...ancestors, canonical]);
    for (const name of await files.children(folder)) if (!name.startsWith('.') || name === '.system') {
      const path = join(folder, name); await entry(async () => { if (await files.kind(path) === 'directory') await walk(path, chain); return null; });
    }
  };
  await walk(root, new Set()); return result;
}
