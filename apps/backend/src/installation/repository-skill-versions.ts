import { REPOSITORY_SKILL_OFFERS, repositorySkillNameSchema, skillVersionDateSchema, type RepositorySkillOffer,
  type SkillName, type SkillsLatestResponse } from '@alpacawork/contract';
import { skillsReceiptDirectory } from '@alpacawork/core/installed-skills';
import { join } from 'node:path';
import { z } from 'zod';
import { publishRecord, readRecord } from './skill-files.js';

const commitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/i),
  commit: z.object({ committer: z.object({ date: skillVersionDateSchema.unwrap() }) }),
});
type Revision = { sha: string; date: string };
const CACHE_MS = 10 * 60_000;

export class RepositorySkillVersions {
  private readonly cache = new Map<RepositorySkillOffer['name'], { until: number; revision: Promise<Revision | null> }>();

  constructor(private readonly fetchCommit: typeof fetch = fetch) {}

  async latest(): Promise<SkillsLatestResponse> {
    const skills = await Promise.all(REPOSITORY_SKILL_OFFERS.map(async offer => {
      const cached = this.cache.get(offer.name);
      const revision = await (cached && cached.until > Date.now() ? cached.revision : this.refresh(offer));
      return { name: offer.name, latestAt: revision?.date ?? null };
    }));
    return { skills };
  }

  /** Installation reads a fresh revision and pins the download to the commit whose date it records. */
  refresh(offer: RepositorySkillOffer): Promise<Revision | null> {
    const revision = this.load(offer);
    this.cache.set(offer.name, { until: Date.now() + CACHE_MS, revision });
    return revision;
  }

  private async load({ name, from }: RepositorySkillOffer): Promise<Revision | null> {
    try {
      const url = new URL(`https://api.github.com/repos/${from.repo}/commits`);
      url.search = new URLSearchParams({ path: `skills/${name}`, per_page: '1' }).toString();
      const response = await this.fetchCommit(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const parsed = z.array(commitSchema).safeParse(await response.json());
      const commit = parsed.success ? parsed.data[0] : undefined;
      return commit ? { sha: commit.sha, date: commit.commit.committer.date } : null;
    } catch {
      return null;
    }
  }
}

const installedVersionsSchema = z.partialRecord(repositorySkillNameSchema, skillVersionDateSchema);

/** Records repository versions separately from the receipt that controls bundled replacements. */
export class InstalledRepositorySkillVersions {
  private readonly path: string;

  constructor(root: string) {
    this.path = join(skillsReceiptDirectory(root), 'repository-skill-versions.json');
  }

  read(): Partial<Record<SkillName, string | null>> {
    return installedVersionsSchema.parse(readRecord(this.path) ?? {});
  }

  /** Called under the skill-root installation lock. */
  record(name: RepositorySkillOffer['name'], date: string | null): void {
    publishRecord(this.path, installedVersionsSchema.parse({ ...this.read(), [name]: date }));
  }
}
