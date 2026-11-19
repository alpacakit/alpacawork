import { fenceLines } from './markdown-fences.js';
import { fileKind, reportEmbeds, type ReportFileKind } from './markdown-embeds.js';

/** The one path rule for media in a report description. Existence is checked by the writer. */
function taskRelativePath(href: string): string | null {
  if (!href || href.startsWith('/') || href.includes('\\') || href.includes('\0') ||
      /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const segments = href.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..') ? href : null;
}
/**
 * A reference a report may embed with ![purpose](path) (EMBEDS: an image, video, audio or diff): its Task-relative path and
 * the kind the writer checks and the screen draws it as. Null for a path outside the Task folder or a file no embed.
 */
export function reportEmbed(href: string): { path: string; kind: ReportFileKind } | null {
  const path = taskRelativePath(href), kind = path ? fileKind(path) : null;
  return path && kind && reportEmbeds(kind) ? { path, kind } : null;
}

/** The inline link syntax shared by the report writer and reader. */
export const INLINE_MARKDOWN_LINK = /(!?\[[^\]]*\]\([^)]*?\))/g;
const INLINE_MARKDOWN_LINK_PARTS = /^(!?)\[([^\]]*)\]\((.*)\)$/;
const INLINE_MARKDOWN_CODE = /`[^`]+`/g;

export type InlineLink = { at: number; image: boolean; label: string; href: string };
/** A line's links outside inline code, with where each starts: what writers check and readers number must be the same links. */
export function inlineLinks(line: string): InlineLink[] {
  const links: InlineLink[] = [];
  if (!line.includes("[")) return links;
  let start = 0;
  const appendLinks = (end: number) => {
    for (const match of line.slice(start, end).matchAll(INLINE_MARKDOWN_LINK)) {
      const [, image, label, href] = INLINE_MARKDOWN_LINK_PARTS.exec(match[0])!;
      links.push({ at: start + match.index, image: image === '!', label: label!, href: href! });
    }
  };
  for (const code of line.matchAll(INLINE_MARKDOWN_CODE)) {
    appendLinks(code.index);
    start = code.index + code[0].length;
  }
  appendLinks(line.length);
  return links;
}

/** Explicit Markdown links outside fenced and inline code, shared by writers and readers. */
export function markdownLinks(text: string): Omit<InlineLink, 'at'>[] {
  const fences = fenceLines();
  const links: Omit<InlineLink, 'at'>[] = [];
  for (const line of text.split('\n')) if (!fences(line)) links.push(...inlineLinks(line));
  return links;
}

/** Includes invalid paths so the writer can reject them, rather than silently ignoring media. */
export function reportMediaReferences(description: string): { alt: string; path: string }[] {
  return markdownLinks(description).filter(link => link.image).map(link => ({ alt: link.label, path: link.href }));
}
