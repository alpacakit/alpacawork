import { fenceKind, galleryFenceKinds, inGallery, type GalleryFenceKind } from "./markdown-embeds.js";
import { inlineLinks } from "./report-media.js";
import { isDrawnTag } from "./markdown-html.js";
import { LIST_ITEM, fenceLines } from "./markdown-fences.js";

export * from "./markdown-html.js";

type Block<T = string> =
  | { type: "heading"; level: number; text: T }
  | { type: "p"; text: T }
  | { type: "quote"; paragraphs: T[] }
  | { type: "list"; ordered: boolean; start: number; items: T[] }
  | { type: "table"; rows: T[][] }
  /** `nested`: written under a list item (indented to its text), drawn under that item. */
  | { type: "code"; text: string; language: string; closed: boolean; nested?: true }
  /** Its lines as written: HTML, its words not read as Markdown (as GitHub reads an HTML block). */
  | { type: "html"; text: string };

/** CommonMark's HTML block starts (types 1, 2, 6 and 7), each with the line that ends it: a blank line unless named. */
const HTML_BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt "
  + "fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav "
  + "noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul").split(" "));
const RAW_HTML = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;
const LONE_TAG = /^ {0,3}(?:<([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/([A-Za-z][A-Za-z0-9-]*)\s*>)\s*$/;
function htmlBlockEnd(line: string): RegExp | "blank" | null {
  const raw = RAW_HTML.exec(line);
  if (raw) return new RegExp(`</${raw[1]}>`, "i");
  if (/^ {0,3}<!--/.test(line)) return /-->/;
  const name = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(line)?.[1]?.toLowerCase();
  if (name && HTML_BLOCK_TAGS.has(name)) return "blank";
  // A line of one tag alone (type 7) only for a tag that is drawn: "<ID>" alone is words, not the start of HTML.
  const lone = LONE_TAG.exec(line);
  return lone && isDrawnTag((lone[1] ?? lone[2]!).toLowerCase()) ? "blank" : null;
}

/** The Markdown line loop, producing blocks instead of HTML. */
export function parseMarkdown(text: string): Block[] { return parseBlocks(text, value => value); }

/** Original offsets after each complete block, shared by writers that insert an attachment after its source. */
export function markdownBlockEnds(text: string): number[] {
  const ends: number[] = [];
  parseBlocks(text, value => value, undefined, undefined, end => ends.push(end));
  return ends;
}

function parseBlocks<T>(text: string, inline: (value: string, at: number) => T,
  onLine?: (value: string) => void, onCode?: (source: string, language: string) => void, onBlock?: (end: number) => void): Block<T>[] {
  const blocks: Block<T>[] = [];
  let offset = 0, listEnd = 0, tableEnd = 0, quoteEnd = 0;
  let list: { ordered: boolean; start: number; items: T[] } | null = null;
  let quote: T[] | null = null;
  let table: T[][] | null = null;
  let code: string[] | null = null;
  let nested = false;
  const fences = fenceLines();
  let html: { lines: string[]; end: RegExp | "blank" } | null = null;
  let language = "";
  const closeList = () => {
    if (list) { blocks.push({ type: "list", ...list }); onBlock?.(listEnd); }
    list = null;
  };
  const closeTable = () => {
    if (table) { blocks.push({ type: "table", rows: table }); onBlock?.(tableEnd); }
    table = null;
  };
  const closeQuote = () => {
    if (quote?.length) { blocks.push({ type: "quote", paragraphs: quote }); onBlock?.(quoteEnd); }
    quote = null;
  };
  // Lines end in "\n" or "\r\n" alike (a report written on Windows).
  for (const line of text.split(/\r?\n/)) {
    offset += line.length;
    if (text[offset] === "\r") offset++;
    if (text[offset] === "\n") offset++;
    // An HTML block runs to its end line (CommonMark), Markdown marks inside it included.
    if (html) {
      if (html.end === "blank" && !line.trim()) { blocks.push({ type: "html", text: html.lines.join("\n") }); onBlock?.(offset); html = null; continue; }
      html.lines.push(line);
      if (html.end !== "blank" && html.end.test(line)) { blocks.push({ type: "html", text: html.lines.join("\n") }); onBlock?.(offset); html = null; }
      continue;
    }
    const fenced = fences(line);
    if (fenced && "edge" in fenced) {
      closeList();
      closeTable();
      closeQuote();
      if (fenced.edge === "close") {
        const source = code!.join("\n");
        blocks.push({ type: "code", text: source, language, closed: true, ...nested && { nested: true as const } });
        onCode?.(source, language);
        onBlock?.(offset);
        code = null;
      } else ({ language, nested } = fenced, code = []);
      continue;
    }
    if (fenced) {
      code!.push(fenced.code);
      continue;
    }
    const htmlEnd = htmlBlockEnd(line);
    if (htmlEnd) {
      closeList();
      closeTable();
      closeQuote();
      html = { lines: [line], end: htmlEnd };
      if (htmlEnd !== "blank" && htmlEnd.test(line.slice(line.indexOf("<") + 2))) { blocks.push({ type: "html", text: line }); onBlock?.(offset); html = null; }
      continue;
    }
    onLine?.(line);
    // A quote: lines that start with ">" and an optional space (CommonMark), one block until another line. Each of its
    // lines is a paragraph as outside a quote; a bare ">" is its blank line, not a letter.
    if (line.startsWith(">")) {
      closeList();
      closeTable();
      quote ??= [];
      const words = line.replace(/^> ?/, "");
      if (words.trim()) quote.push(inline(words, line.length - words.length));
      quoteEnd = offset;
      continue;
    }
    closeQuote();
    if (line.startsWith("|")) {
      closeList();
      table ??= [];
      tableEnd = offset;
      if (!/^\|[\s:|-]+\|$/.test(line)) {
        let cellStart = 1;
        table.push(line.split("|").slice(1, -1).map(cell => {
          const at = cellStart + cell.length - cell.trimStart().length;
          cellStart += cell.length + 1;
          return inline(cell.trim(), at);
        }));
      }
      continue;
    }
    closeTable();
    // A list's items: "- " bullets, or "1. " numbers (from the first item's number); a change of kind starts another list.
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = item[1] !== undefined;
      if (list && list.ordered !== ordered) closeList();
      (list ??= { ordered, start: ordered ? Number(item[1]) : 1, items: [] }).items.push(inline(item[2]!, line.length - item[2]!.length));
      listEnd = offset;
      continue;
    }
    closeList();
    if (/^#{1,4} /.test(line)) blocks.push({ type: "heading", level: line.indexOf(" "), text: inline(line.replace(/^#+ /, ""), line.indexOf(" ") + 1) });
    else if (line.trim()) blocks.push({ type: "p", text: inline(line, 0) });
    if (line.trim()) onBlock?.(offset);
  }
  closeList();
  closeTable();
  closeQuote();
  if (html) { blocks.push({ type: "html", text: html.lines.join("\n") }); onBlock?.(text.length); }
  // In-progress text remains copyable code. Only a closing fence notifies the media inventory.
  if (code) { blocks.push({ type: "code", text: code.join("\n"), language, closed: false, ...nested && { nested: true as const } }); onBlock?.(text.length); }
  return blocks;
}

/** Each occurrence keeps its own identity, including invalid file references and repeated diagrams. */
export type MarkdownMedium =
  | { kind: "file"; occurrence: number; path: string; alt: string }
  | { kind: GalleryFenceKind; occurrence: number; source: string };
/** A fenced block in the media list (EMBEDS: a diagram), numbered per kind. */
export type FenceMedium = Extract<MarkdownMedium, { source: string }>;
export type InlineContent = { text: string; media: { at: number; medium: MarkdownMedium }[] };
type MarkdownBlock = Block<InlineContent> & { medium?: FenceMedium };
export const markdownMediumId = (key: string, medium: MarkdownMedium) => JSON.stringify(
  medium.kind === "file" ? [key, medium.occurrence] : [key, medium.kind, medium.occurrence]);

/** The URL accepts the existing file identity and a fenced medium's (a diagram's) identity owned here. */
export function isMarkdownMediumId(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || !parsed[0]) return false;
    const occurrence: unknown = parsed.length === 2 ? parsed[1]
      : parsed.length === 3 && (galleryFenceKinds as unknown[]).includes(parsed[1]) ? parsed[2] : null;
    return typeof occurrence === "number" && Number.isSafeInteger(occurrence) && occurrence >= 0;
  } catch { return false; }
}

/** The sole inventory for both the renderer and galleries. File numbering is the existing image-only URL numbering.
 * Inline offsets survive emphasis/code splitting, so duplicate links never depend on a DOM search or their labels. */
export function markdownDocument(text: string): { blocks: MarkdownBlock[]; media: MarkdownMedium[] } {
  const media: MarkdownMedium[] = [];
  let files = 0;
  let lineMedia: InlineContent["media"] = [];
  const fenced: FenceMedium[] = [];
  const counts = new Map<GalleryFenceKind, number>();
  const scanLine = (text: string) => {
    // Count the original line before headings/lists/tables strip their marks. This keeps the writer's
    // existing image-only numbering even for a malformed table or an invalid/unrendered reference.
    lineMedia = [];
    if (!text.includes("![")) return;
    inlineLinks(text).forEach(({ at, image, label, href }) => {
      if (!image) return;
      const medium: MarkdownMedium = { kind: "file", occurrence: files++, alt: label, path: href };
      media.push(medium);
      lineMedia.push({ at, medium });
    });
  };
  // A closed fence of a kind in the media list (EMBEDS) is a medium of that kind.
  const listed = (language: string) => { const kind = fenceKind(language); return kind && inGallery(kind) ? kind : null; };
  const parsed = parseBlocks(text, (text, at): InlineContent => {
    const inlineMedia: InlineContent["media"] = [];
    lineMedia.forEach(item => {
      if (item.at >= at && item.at < at + text.length) inlineMedia.push({ ...item, at: item.at - at });
    });
    return { text, media: inlineMedia };
  },
  scanLine, (source, language) => {
    const kind = listed(language);
    if (!kind) return;
    const occurrence = counts.get(kind) ?? 0;
    counts.set(kind, occurrence + 1);
    const medium: FenceMedium = { kind, occurrence, source };
    fenced.push(medium);
    media.push(medium);
  });
  if (!fenced.length) return { blocks: parsed, media };
  let at = 0;
  const blocks: MarkdownBlock[] = parsed.map(block => block.type === "code" && block.closed && listed(block.language)
    ? { ...block, medium: fenced[at++] } : block);
  return { blocks, media };
}

export const markdownMedia = (text: string) => markdownDocument(text).media;

/** Original Markdown, ending only at one of the renderer's complete blocks. A first oversized block stays whole. */
export function markdownHead(text: string, limit = 600): string {
  const ends: number[] = [];
  parseBlocks(text, value => value, undefined, undefined, end => ends.push(end));
  let end = ends[0] ?? text.length;
  for (const next of ends.slice(1)) { if (next > limit) break; end = next; }
  return text.slice(0, end);
}
