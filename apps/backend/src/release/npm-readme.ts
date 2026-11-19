/**
 * The README as npm shows it. The repository's README links to its own files by relative path, which GitHub
 * resolves on every branch; npm resolves none, so each relative target becomes an absolute URL: a file the
 * package carries opens from this version of the published package on unpkg, any other file from the
 * repository on GitHub. A picture must be in the package: the repository may not be public.
 * Only `[text](path)`, `src="path"`, `srcset="..."` and `href="path"` are rewritten; the README's header comment says so.
 */
export function npmReadme(text: string, packageName: string, version: string, repositoryUrl: string | undefined,
  inPackage: (path: string) => boolean): string {
  const absolute = (target: string, picture: boolean): string => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
    const path = target.replace(/^\.\//, ''), file = path.split(/[?#]/)[0]!;
    if (inPackage(file)) return `https://unpkg.com/${packageName}@${version}/${path}`;
    if (picture) throw new Error(`README shows ${file}, which the package does not carry`);
    if (!repositoryUrl) throw new Error(`README links to ${file}, which the package does not carry, and the package names no repository`);
    return `${repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '')}/blob/main/${path}`;
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
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (_, bang: string, label: string, target: string) => `${bang}[${label}](${absolute(target, bang === '!')})`)
    .replace(/\b(src|srcset|href)="([^"]+)"/g, (_, attribute: string, target: string) =>
      `${attribute}="${attribute === 'srcset' ? sourceSet(target) : absolute(target, attribute === 'src')}"`);
}
