/**
 * The README as npm shows it. The repository's README links to its own files by relative path, which GitHub
 * resolves on every branch; npm resolves none, so each relative target becomes an absolute URL: a file the
 * package carries opens from this version of the published package on unpkg. Other pictures come from
 * the source commit on GitHub, which shows them only while the repository is public; other links open the
 * corresponding repository page.
 * Of relative paths, only `[text](path)`, `src="path"`, `srcset="..."` and `href="path"` are rewritten; the README's header comment says so.
 * A line that is only the URL of a video GitHub hosts (GitHub plays it in place) becomes an explicit link to the video,
 * so opening it does not depend on a renderer linking bare URLs.
 */
export function npmReadme(text: string, packageName: string, version: string, source: string, repositoryUrl: string | undefined,
  inPackage: (path: string) => boolean): string {
  const repository = repositoryUrl?.replace(/^git\+/, '').replace(/\/$/, '').replace(/\.git$/, '');
  const githubRepo = repository?.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/i)?.[1];
  const absolute = (target: string, picture: boolean): string => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
    const path = target.replace(/^\.\//, ''), file = path.split(/[?#]/)[0]!;
    if (inPackage(file)) return `https://unpkg.com/${packageName}@${version}/${path}`;
    if (!repository) throw new Error(`README refers to ${file}, which the package does not carry, and the package names no repository`);
    if (!picture) return `${repository}/blob/main/${path}`;
    if (!githubRepo) throw new Error(`README image ${file} requires a GitHub repository URL`);
    return `https://raw.githubusercontent.com/${githubRepo}/${source}/${path}`;
  };
  const sourceSet = (input: string): string => {
    let result = '';
    while (input) {
      const leading = input.match(/^[\s,]*/)![0];
      result += leading; input = input.slice(leading.length);
      if (!input) break;
      // URLs end at whitespace; embedded commas (such as in data URLs) belong to the URL.
      const token = input.match(/^\S+/)![0], target = token.replace(/,+$/, '');
      result += absolute(target, true) + token.slice(target.length); input = input.slice(token.length);
      if (token.endsWith(',')) continue;
      const descriptor = input.match(/^[^,]*(?:,|$)/)![0];
      result += descriptor; input = input.slice(descriptor.length);
    }
    return result;
  };
  return text
    .replace(/^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/gm, url => `[${url}](${url})`)
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (_, bang: string, label: string, target: string) => `${bang}[${label}](${absolute(target, bang === '!')})`)
    .replace(/\b(src|srcset|href)="([^"]+)"/g, (_, attribute: string, target: string) =>
      `${attribute}="${attribute === 'srcset' ? sourceSet(target) : absolute(target, attribute === 'src')}"`);
}
