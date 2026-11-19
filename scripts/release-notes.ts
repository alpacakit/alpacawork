/** Usage: node scripts/release-notes.ts CHANGELOG.md VERSION GENERATED_NOTES_FILE [VERSION_PR]
 * Exit 3, with no output, means the version has no section; other failures exit 1.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.replace(/<!--[^]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex(line => line.trimEnd() === `## ${version}`);
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
}

export function createReleaseNotes(changelog: string, version: string, generated: string, versionPr?: string): string | null {
  const section = changelogSection(changelog, version);
  if (section === null) return null;
  if (!section) throw new Error(`Empty CHANGELOG.md section: ## ${version}`);

  const fullChangelog: string[] = [];
  type PullRequest = { title: string; author: string; url: string; number: string };
  const entries = generated.split(/\r?\n/).flatMap<{ line: string; pr: PullRequest | null }>(line => {
    if (/^\*\*Full Changelog\*\*:/.test(line)) {
      fullChangelog.push(line);
      return [];
    }
    // The folded list's summary already names it.
    if (line === "## What's Changed") return [];
    const pr = /^\* (.+) by @([\w-]+(?:\[bot\])?) in (https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))$/.exec(line);
    if (!pr) return [{ line, pr: null }];
    if (pr[4] === versionPr) return [];
    return [{ line, pr: { title: pr[1]!.replace(/^[a-z]+(?:\([^)]*\))?!?: (.)/, (_, first: string) => first.toUpperCase()), author: pr[2]!, url: pr[3]!, number: pr[4]! } }];
  });
  const prs = entries.flatMap(entry => entry.pr ? [entry.pr] : []);
  const showAuthors = new Set(prs.map(pr => pr.author)).size > 1;
  const list = entries.map(({ line, pr }) => pr
    ? `- ${pr.title}${showAuthors ? ` by @${pr.author}` : ''} ([#${pr.number}](${pr.url}))`
    : line).join('\n').trim();
  const folded = list ? `\n\n<details><summary>All ${prs.length} pull request${prs.length === 1 ? '' : 's'}</summary>\n\n${list}\n\n</details>` : '';
  return `${section}${folded}\n${fullChangelog.length ? `\n${fullChangelog.join('\n')}\n` : ''}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [changelogPath, version, generatedPath, versionPr, ...extra] = process.argv.slice(2);
    if (!changelogPath || !version || !generatedPath || extra.length || (versionPr !== undefined && !/^\d+$/.test(versionPr)))
      throw new Error('Usage: node scripts/release-notes.ts CHANGELOG.md VERSION GENERATED_NOTES_FILE [VERSION_PR]');
    const notes = createReleaseNotes(readFileSync(changelogPath, 'utf8'), version, readFileSync(generatedPath, 'utf8'), versionPr);
    if (notes === null) process.exitCode = 3;
    else process.stdout.write(notes);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
