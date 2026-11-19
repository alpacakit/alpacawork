/** The one real copy of a managed skill is under ~/.agents/skills. An agent kind that does not read that folder gets a
 * link from the folder it does read: the writer links each skill it places, and unlinks each one it removes. A HOME uses
 * a kind when the folder holding that kind's skills folder exists, or setup found the kind's command; no other HOME
 * gets that folder. */
import { lstatSync, mkdirSync, realpathSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hasCode } from '@alpacawork/core';
import { managedSkillsRoot } from '@alpacawork/core/installed-skills';
import type { BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';

/** Where each kind reads personal skills, relative to HOME. null: no link, because the kind reads ~/.agents/skills
 * itself (agy does not, but nothing its maker publishes says it loads a linked skill). Sources as read on 2026-11-11. */
const PERSONAL_SKILLS: Readonly<Record<BuiltinAdapterId, string | null>> = {
  claude: '.claude/skills', // its own folder only; a linked skill is read: https://code.claude.com/docs/en/skills
  agy: null, // ~/.gemini/config/skills; links are not documented: https://antigravity.google/docs/skills
  codex: null, // https://learn.chatgpt.com/docs/build-skills
  grok: null, // https://docs.x.ai/build/features/skills-plugins-marketplaces
  copilot: null, // https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
  pi: null, // https://pi.dev/docs/latest/skills
};

export type AgentSkillLink = { path: string; target: string; action: 'create-folder' | 'create' | 'keep' | 'conflict' };

/** The links live in the HOME that owns the root, never in the caller's: one folder for each linked kind that HOME uses. */
function linkFolders(root: string, detected: readonly string[]): string[] {
  const home = dirname(dirname(root));
  if (managedSkillsRoot(home) !== root) return [];
  return Object.entries(PERSONAL_SKILLS).flatMap(([kind, folder]) => folder
    && (detected.includes(kind) || statSync(join(home, dirname(folder)), { throwIfNoEntry: false })?.isDirectory()) ? [join(home, folder)] : []);
}
const ours = (path: string, target: string) =>
  !!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target;

const sameFiles = (path: string, target: string) => {
  try { return realpathSync(path) === realpathSync(target); } catch (error) { if (hasCode(error, 'ENOENT') || hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR')) return false; throw error; }
};

/** Read-only. Before placement this is the plan; after it, every entry is keep or conflict. */
export function inspectAgentSkillLinks(root: string, names: readonly string[], detected: readonly string[]): AgentSkillLink[] {
  return linkFolders(root, detected).flatMap(directory => {
    const folder = statSync(directory, { throwIfNoEntry: false })?.isDirectory();
    return names.map((name): AgentSkillLink => {
      const path = join(directory, name), target = join(root, name);
      return { path, target, action: !folder ? 'create-folder' : sameFiles(path, target) || ours(path, target) && !lstatSync(target, { throwIfNoEntry: false }) ? 'keep'
        : lstatSync(path, { throwIfNoEntry: false }) ? 'conflict' : 'create' };
    });
  });
}
/** Anything else already at a link's path is the person's own content: it stays, and is never replaced or removed. */
export function syncAgentSkillLinks(root: string, intent: { place: readonly string[]; remove: readonly string[] }, detected: readonly string[]): void {
  for (const directory of linkFolders(root, detected)) {
    if (intent.place.length) mkdirSync(directory, { recursive: true });
    for (const name of intent.place) {
      try { symlinkSync(join(root, name), join(directory, name), 'dir'); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    for (const name of intent.remove) if (ours(join(directory, name), join(root, name))) unlinkSync(join(directory, name));
  }
}
