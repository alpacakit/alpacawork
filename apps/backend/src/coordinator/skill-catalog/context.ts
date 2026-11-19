import { dirname, join, resolve } from 'node:path';
import { Files, CatalogUnavailable } from './files.js';
/** `root` is the workspace's: the catalog is the one a coordinator turn finds from its own folder there. */
export type CatalogInput = { profile: string; root: string; argv: string[]; env: Record<string, string | undefined>; session: string | null };
/** No git command: resolve ordinary .git directories and linked worktrees from their on-disk pointers. */
export async function projectRoots(files: Files, cwd: string): Promise<{ chain: string[]; main: string | null }> {
  const chain: string[] = [];
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    if (chain.length > 64) throw new CatalogUnavailable('limit');
    chain.push(folder);
    const git = join(folder, '.git'), kind = await files.kind(git);
    if (kind) {
      if (kind === 'directory') return { chain, main: null };
      const pointer = /^gitdir: (.+)\s*$/.exec((await files.text(git))!);
      if (!pointer) throw new CatalogUnavailable('settings');
      const gitdir = resolve(folder, pointer[1]!.trim()), common = await files.text(join(gitdir, 'commondir'));
      if (!common) throw new CatalogUnavailable('settings');
      const commonDir = resolve(gitdir, common.trim()), main = dirname(commonDir);
      if (await files.canonical(join(main, '.git')) !== await files.canonical(commonDir)) throw new CatalogUnavailable('settings');
      return { chain, main };
    }
    if (dirname(folder) === folder) return { chain, main: null };
  }
}
