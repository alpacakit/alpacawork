import { decodeEntities, htmlNodes, htmlPieces, inlineNodes, markdownDocument, type InlineContent, type InlineNode } from "./markdown";
import { BARE_PATH, localTarget, managedFileTarget, type LocalTarget } from "./local-path";
import type { TaskFile } from "./task-files";
import { bareUrls } from "./web-link";

/**
 * Which references in a task's words are links to a file of a Task folder, and in which words they are read: the one
 * judgment the Markdown renderer (MarkdownBody) draws them by and the Files tab lists the Deliverables field's files by.
 */

/** What a reference is read against: the Task whose words they are, the workspace root, the file they are written in. */
export type ReferenceScope = { task: { id: string; files: TaskFile[] } | null; root: string | null; sourceFile?: string; origin: string };

/** A written link's or image's address (Markdown or HTML): a file of this screen's address, or a local path. */
export const writtenTarget = (href: string, scope: ReferenceScope): LocalTarget | null =>
  managedFileTarget(href, scope.origin, scope.task) ?? localTarget(href, scope.task, scope.root, scope.sourceFile);
/** A web address found in words: a Task file when it is this screen's address of one. */
export const addressTarget = (href: string, scope: ReferenceScope): LocalTarget | null => managedFileTarget(href, scope.origin, scope.task);
/** A bare absolute path found in words (BARE_PATH). */
export const pathTarget = (path: string, scope: ReferenceScope): LocalTarget | null => localTarget(path, scope.task, scope.root);
/** Code's words: a path when absolute, or naming what the Task folder holds; other code stays code. */
export function codeTarget(inner: string, scope: ReferenceScope): LocalTarget | null {
  const { task } = scope;
  const named = /^(?:~|\/|file:)/.test(inner) || task?.files.some(file => file.name === inner || (inner.endsWith("/") && file.name.startsWith(inner)));
  return named ? localTarget(inner, task, scope.root, scope.sourceFile) : null;
}

/** Tags whose words read as written: a link's (no link inside a link) and code's. */
const AS_WRITTEN = new Set(["a", "code", "pre", "kbd", "samp", "tt"]);
/** Elements with no children drawn. */
export const VOID_TAGS = new Set(["br", "hr", "wbr", "col"]);

/** How words read where they stand: as written (no address found in them), and inside a link (no link in them). */
export type Reading = { asWritten: boolean; inLink: boolean };
/**
 * How a node of a line's tree (inlineNodes) is drawn, as far as references go: the address it links to (judged by
 * writtenTarget), what its own words are looked through as (`addresses`: web addresses and paths; `code`: a path), and
 * how its children read, null where they are not drawn. Every node kind MarkdownBody draws is decided here.
 * - text: its words, unless read as written.
 * - code: a path (codeTarget), wherever it stands.
 * - strong: its children, read as it is.
 * - a Markdown link: its address, unless inside a link; its words drawn as written, inside a link.
 * - a Markdown image: its address, wherever it stands; its words are its label, the tree under them not drawn.
 * - an HTML a: its href, unless inside a link; its children as written, inside a link.
 * - an HTML img: its src; no children. A void element (VOID_TAGS): no children.
 * - any other element: its children, as written under AS_WRITTEN.
 */
export function nodeReading(node: InlineNode, { asWritten, inLink }: Reading):
  { link: string | null; words: "addresses" | "code" | null; children: Reading | null } {
  switch (node.kind) {
    case "text": return { link: null, words: asWritten ? null : "addresses", children: null };
    case "code": return { link: null, words: "code", children: null };
    case "strong": return { link: null, words: null, children: { asWritten, inLink } };
    case "link": return node.image ? { link: node.href, words: null, children: null }
      : { link: inLink ? null : node.href, words: null, children: { asWritten: true, inLink: true } };
  }
  const { tag, attrs } = node;
  if (tag === "img") return { link: attrs.src || null, words: null, children: null };
  return { link: tag === "a" && !inLink ? attrs.href || null : null, words: null,
    children: VOID_TAGS.has(tag) ? null : { asWritten: asWritten || AS_WRITTEN.has(tag), inLink: inLink || tag === "a" } };
}
/** A linking node's words, as drawn: an image's label (its alt), a link's children. */
const linkWords = (node: InlineNode): string => node.kind === "link" && node.image ? node.label
  : node.kind === "element" && node.tag === "img" ? node.attrs.alt ?? "" : "children" in node ? drawnWords(node.children) : "";

/** Words as drawn: character references read, code as written, an image by its words. */
export const drawnWords = (nodes: InlineNode[]): string => nodes.map(node => node.kind === "text" ? decodeEntities(node.text)
  : node.kind === "code" ? node.text : node.kind === "link" && node.image ? node.label : drawnWords(node.children)).join("");

/** A reference drawn as a link to a file or folder of a Task folder; `label` its words, null where the drawing names it. */
export type FileReference = { target: Extract<LocalTarget, { kind: "task" }>; label: string | null };

/**
 * The file references a Markdown text draws, in its order, read as MarkdownBody reads them: each block's line tree
 * (inlineNodes; an HTML block's as written), links and images, code, and the addresses and paths in plain words.
 */
export function fileReferences(text: string, scope: ReferenceScope): FileReference[] {
  const found: FileReference[] = [];
  const add = (target: LocalTarget | null, label: string | null) => {
    if (target?.kind === "task") found.push({ target, label: label || null });
  };
  const words = (value: string) => {
    let last = 0;
    const paths = (between: string) => { for (const match of between.matchAll(BARE_PATH)) add(pathTarget(match[1]!, scope), null); };
    for (const url of bareUrls(value)) {
      paths(value.slice(last, url.index));
      add(addressTarget(url.captured, scope), null);
      last = url.index + url.length;
    }
    paths(value.slice(last));
  };
  const walk = (nodes: InlineNode[], reading: Reading) => {
    for (const node of nodes) {
      const { link, words: own, children } = nodeReading(node, reading);
      if (own === "addresses" && node.kind === "text") words(node.text);
      if (own === "code" && node.kind === "code") add(codeTarget(node.text, scope), null);
      if (link) add(writtenTarget(link, scope), linkWords(node));
      if (children && "children" in node) walk(node.children, children);
    }
  };
  const inline = (content: InlineContent) => walk(inlineNodes(content.text, { markdown: true }), { asWritten: false, inLink: false });
  for (const block of markdownDocument(text).blocks) {
    if (block.type === "heading" || block.type === "p") inline(block.text);
    else if (block.type === "quote") block.paragraphs.forEach(inline);
    else if (block.type === "list") block.items.forEach(inline);
    else if (block.type === "table") block.rows.flat().forEach(inline);
    // An HTML block is drawn in pieces where it closes a fold an earlier block left open, each as written.
    else if (block.type === "html") for (const piece of htmlPieces(block.text)) walk(htmlNodes(piece.text), { asWritten: true, inLink: false });
  }
  return found;
}
