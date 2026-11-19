/**
 * The HTML a Markdown text may hold, as GitHub draws it: only the tags and attributes a README uses for its layout
 * (PERMITTED), each URL only to a web page, a mail address or a place in the text's own folder. A tag whose words must
 * not show (a script, a style, a frame) goes with its words; any other tag stays the letters it was written in, so
 * "<ID>" in a sentence still reads.
 *
 * A line is read once into one tree (inlineNodes): code, HTML tags, `**bold**` and `[links](…)` are each a range of it,
 * a range kept only where it nests with the others, so bold may hold a tag and a tag bold, but neither cuts the other.
 */
export type InlineNode =
  | { kind: "text"; text: string; at: number }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "code"; text: string }
  /** A Markdown link or image (`at`: where it starts, its media's place), its label's HTML as `children`. */
  | { kind: "link"; image: boolean; label: string; href: string; at: number; children: InlineNode[] }
  | { kind: "element"; tag: string; attrs: Record<string, string>; children: InlineNode[]; open?: true };

/**
 * Elements a block may leave open for the Markdown under it to go in, up to the block that closes them: a fold's or a
 * section's words after a blank line, as GitHub reads them.
 */
export const CONTAINERS = new Set(["details", "div"]);

const GLOBAL = ["align", "title", "lang", "dir"];
/** The tags drawn, each with the attributes it keeps beside GLOBAL's. */
const PERMITTED: Record<string, string[]> = {
  a: ["href"], img: ["src", "alt", "width", "height"], picture: [],
  p: [], div: [], span: [], br: [], hr: [], wbr: [], b: [], strong: [], i: [], em: [], u: [], s: [], strike: [], del: [], ins: [],
  sub: [], sup: [], small: [], mark: [], kbd: [], code: [], tt: [], samp: [], var: [], q: [], cite: [], abbr: [], dfn: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], blockquote: [], pre: [],
  ul: [], ol: ["start", "type"], li: [], dl: [], dt: [], dd: [],
  details: ["open"], summary: [], figure: [], figcaption: [],
  table: ["width"], caption: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["colspan", "rowspan", "valign", "width", "scope"],
  td: ["colspan", "rowspan", "valign", "width"], colgroup: ["span"], col: ["span", "width"],
};
const VOID = new Set(["br", "hr", "wbr", "img", "col"]);
/** Tags whose words go with them. */
const SILENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "svg", "math", "select", "head", "frameset", "noframes"]);
/** Tags dropped alone, their words kept. A picture's sources go too: it shows its own image, as the screen has its own light and dark. */
const DROPPED = new Set(["source", "html", "body", "form", "input", "button", "label", "option", "optgroup", "link", "meta", "base", "font", "center", "frame"]);

const TAG = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const CODE_SPAN = /`[^`]+`/g;

/** Whether a tag's name is one this reads as HTML (drawn, or dropped); any other stays its letters. */
export const isHtmlTag = (name: string) => Object.hasOwn(PERMITTED, name) || SILENT.has(name) || DROPPED.has(name);
/** Whether a tag's name is one that is drawn. */
export const isDrawnTag = (name: string) => Object.hasOwn(PERMITTED, name);

/** Whether a text holds anything this reads as HTML, so a line without it costs nothing. */
export const mayHoldHtml = (text: string) => /<(?:!--|\/?[A-Za-z])/.test(text);


type Range = { start: number; end: number; inner: [number, number] | null; node?: (children: InlineNode[]) => InlineNode };
const EMPHASIS = /\*\*(.+?)\*\*/g;
const LINK = /(!?)\[([^\]]*)\]\(([^)]*?)\)/g;

/**
 * Tags an opening tag closes when one is open (HTML's implied ends): `stops` an element between them that keeps it open
 * (a list inside a list item, a table inside a cell).
 */
const IMPLIED: Record<string, { closes: string[]; stops: string[] }> = {};
const imply = (tags: string, closes: string, stops: string) => tags.split(" ").forEach(tag => {
  IMPLIED[tag] = { closes: closes.split(" "), stops: stops.split(" ") };
});
imply("li", "li", "ul ol table");
imply("dt dd", "dt dd", "dl table");
imply("tr", "tr td th", "table");
imply("td th", "td th", "tr table");
imply("thead tbody tfoot", "thead tbody tfoot tr td th", "table");
// A paragraph ends where a block starts.
imply("p div ul ol dl table h1 h2 h3 h4 h5 h6 pre blockquote details figure hr", "p", "td th caption table div blockquote details li dd figure");

/**
 * A text read as Markdown's words and HTML (`markdown`: a line), or as HTML alone (an HTML block, where GitHub reads no
 * Markdown and a backtick is a letter): its tree, and where it closes a container it did not open (`strays`). Code and
 * tags are read in the order written, the first to start claiming its letters; then bold, then links. A range that
 * cuts one claimed before it is left as its letters. A link holds no bold and no code (bold may hold a link).
 */
function read(text: string, markdown: boolean): { nodes: InlineNode[]; strays: [number, number][] } {
  const ranges: Range[] = [];
  const strays: [number, number][] = [];
  const nests = (a: Range, b: Range) => a.end <= b.start || b.end <= a.start
    || (!!b.inner && a.start >= b.inner[0] && a.end <= b.inner[1]) || (!!a.inner && b.start >= a.inner[0] && b.end <= a.inner[1]);
  const fits = (range: Range) => ranges.every(other => nests(range, other));
  type Open = { tag: string; start: number; innerStart: number; attrs: Record<string, string> };
  const stack: Open[] = [];
  const claimed: Range[] = [];
  const codes: Range[] = [];
  const element = (open: Open, innerEnd: number, end: number, closed: boolean) => claimed.push({ start: open.start, end, inner: [open.innerStart, innerEnd],
    node: children => ({ kind: "element", tag: open.tag, attrs: open.attrs, children, ...(closed ? {} : { open: true as const }) }) });
  const closeDownTo = (at: number, where: number) => { while (stack.length > at) element(stack.pop()!, where, where, true); };
  const tokens = new RegExp(`${markdown ? `(${CODE_SPAN.source})|` : "()"}${TAG.source}`, "g");
  for (let found = tokens.exec(text); found; found = tokens.exec(text)) {
    const start = found.index, end = start + found[0].length;
    if (found[1]) {
      const code = found[1].slice(1, -1);
      codes.push({ start, end, inner: null, node: () => ({ kind: "code", text: code }) });
      claimed.push(codes.at(-1)!);
      continue;
    }
    const [, , closing, written = "", attributes = "", selfClosing] = found;
    const tag = written.toLowerCase();
    const comment = found[0].startsWith("<!--");
    // Not a tag this reads: its letters stay, and code may start inside them.
    if (!comment && !isHtmlTag(tag)) { tokens.lastIndex = start + 1; continue; }
    const gone = (to: number) => claimed.push({ start, end: to, inner: null });
    if (comment || DROPPED.has(tag)) { gone(end); continue; }
    if (SILENT.has(tag)) {
      if (closing || selfClosing) { gone(end); continue; }
      // Its words go with it, to its closing tag or, unclosed, to the end.
      const close = new RegExp(`</${tag}\\s*>`, "ig");
      close.lastIndex = end;
      const after = close.exec(text);
      const to = after ? after.index + after[0].length : text.length;
      gone(to);
      tokens.lastIndex = to;
      continue;
    }
    if (closing) {
      const at = stack.map(open => open.tag).lastIndexOf(tag);
      if (at < 0) {
        gone(end);
        if (CONTAINERS.has(tag)) strays.push([start, end]);
        continue;
      }
      // Those opened inside it and left open end where it does.
      while (stack.length > at + 1) element(stack.pop()!, start, start, true);
      element(stack.pop()!, start, end, true);
      continue;
    }
    const implied = IMPLIED[tag];
    if (implied) {
      // The outermost it closes, below the nearest that keeps them open (a new row closes the last row and its cell).
      let outer = -1;
      for (let i = stack.length - 1; i >= 0 && !implied.stops.includes(stack[i]!.tag); i--) if (implied.closes.includes(stack[i]!.tag)) outer = i;
      if (outer >= 0) closeDownTo(outer, start);
    }
    const open: Open = { tag, start, innerStart: end, attrs: permittedAttrs(tag, attributes) };
    if (VOID.has(tag) || selfClosing) element(open, end, end, true);
    else stack.push(open);
  }
  while (stack.length) element(stack.pop()!, text.length, text.length, false);
  ranges.push(...claimed);
  if (markdown) {
    // Marks are found with code and tags masked, so none is found inside them (a tag's attribute included).
    const letters = text.split("");
    const mask = (from: number, to: number) => { for (let i = from; i < to; i++) letters[i] = "\u0000"; };
    for (const range of claimed) {
      if (range.inner) { mask(range.start, range.inner[0]); mask(range.inner[1], range.end); } else mask(range.start, range.end);
    }
    const masked = letters.join("");
    const held: Range[] = [...codes];
    for (const found of masked.matchAll(EMPHASIS)) {
      const end = found.index + found[0].length;
      const range: Range = { start: found.index, end, inner: [found.index + 2, end - 2], node: children => ({ kind: "strong", children }) };
      if (fits(range)) { held.push(range); ranges.push(range); }
    }
    for (const found of masked.matchAll(LINK)) {
      const end = found.index + found[0].length, image = !!found[1];
      // Its parts are where the masked letters found them, read from the text as written.
      const labelStart = found.index + found[1]!.length + 1, labelEnd = labelStart + found[2]!.length;
      const label = text.slice(labelStart, labelEnd), href = text.slice(labelEnd + 2, end - 1);
      const range: Range = { start: found.index, end, inner: [labelStart, labelEnd],
        node: children => ({ kind: "link", image, label, href, at: found.index, children }) };
      // No code or bold in a link (what is wholly inside it).
      if (fits(range) && !held.some(other => other.start >= range.start && other.end <= range.end)) ranges.push(range);
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const build = (from: number, to: number, among: Range[]): InlineNode[] => {
    const nodes: InlineNode[] = [];
    let at = from;
    among.forEach((range, i) => {
      if (range.start < at) return;
      if (range.start > at) nodes.push({ kind: "text", text: text.slice(at, range.start), at });
      const inner = range.inner;
      if (range.node) nodes.push(range.node(inner ? build(inner[0], inner[1], among.slice(i + 1).filter(other => other.start >= inner[0] && other.end <= inner[1])) : []));
      at = range.end;
    });
    if (to > at) nodes.push({ kind: "text", text: text.slice(at, to), at });
    return nodes;
  };
  return { nodes: build(0, text.length, ranges), strays };
}

/** A line's tree (`markdown`), or an HTML block's (HTML alone). */
export const inlineNodes = (text: string, { markdown }: { markdown: boolean }) => read(text, markdown).nodes;
export const htmlNodes = (text: string) => read(text, false).nodes;

/** All the words of nodes as they read (a heading's anchor, a cell's width): marks and tags left out, an image's label kept. */
export const nodeWords = (nodes: InlineNode[]): string => nodes.map(node => node.kind === "text" || node.kind === "code" ? node.text
  : node.kind === "link" && node.image ? node.label : nodeWords(node.children)).join("");

/**
 * An HTML block cut where it closes a container it did not open: each piece with how many such closing tags come
 * before it (`closes`: they step out of the containers earlier blocks left open) and how many containers it leaves
 * open (`opens`: the blocks after it go inside).
 */
export function htmlPieces(text: string): { text: string; closes: number; opens: number }[] {
  const pieces: { text: string; closes: number; opens: number }[] = [];
  let from = 0, closes = 0;
  const piece = (to: number) => {
    const words = text.slice(from, to);
    let opens = 0;
    const walk = (nodes: InlineNode[]) => nodes.forEach(node => {
      if (node.kind !== "element") return;
      if (node.open && CONTAINERS.has(node.tag)) opens++;
      walk(node.children);
    });
    walk(htmlNodes(words));
    if (words.trim() || closes) pieces.push({ text: words, closes, opens });
  };
  for (const [start, end] of read(text, false).strays) {
    if (text.slice(from, start).trim()) { piece(start); closes = 0; }
    closes++;
    from = end;
  }
  piece(text.length);
  return pieces;
}

function permittedAttrs(tag: string, written: string): Record<string, string> {
  const kept: Record<string, string> = {};
  const allowed = [...GLOBAL, ...(Object.hasOwn(PERMITTED, tag) ? PERMITTED[tag]! : [])];
  for (const [, name = "", double, single, bare] of written.matchAll(ATTR)) {
    const key = name.toLowerCase();
    const value = decodeEntities(double ?? single ?? bare ?? "");
    if (!allowed.includes(key)) continue;
    const safe = attrValue(key, value);
    if (safe !== null) kept[key] = safe;
  }
  return kept;
}

function attrValue(name: string, value: string): string | null {
  switch (name) {
    case "href": return safeUrl(value, ["http", "https", "mailto"]);
    case "src": return safeUrl(value, ["http", "https"]);
    case "align": return /^(?:left|center|right|justify)$/i.test(value) ? value.toLowerCase() : null;
    case "valign": return /^(?:top|middle|bottom|baseline)$/i.test(value) ? value.toLowerCase() : null;
    case "width": case "height": return /^\d{1,5}%?$/.test(value.trim()) ? value.trim() : null;
    case "colspan": case "rowspan": case "span": case "start": return /^\d{1,4}$/.test(value.trim()) ? value.trim() : null;
    case "dir": return /^(?:ltr|rtl|auto)$/i.test(value) ? value.toLowerCase() : null;
    case "open": return "";
    default: return value;
  }
}

/** A URL to one of `schemes`, or a place in the text's own folder or page; null for any other (javascript:, data:…). */
export function safeUrl(value: string, schemes: string[]): string | null {
  const url = value.trim();
  // A browser reads a scheme past the control letters and spaces written into it ("java\tscript:").
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url.replace(/[\x00-\x20]/g, ""))?.[1];
  if (scheme) return schemes.includes(scheme.toLowerCase()) && /^[a-z][a-z\d+.-]*:/i.test(url) ? url : null;
  return url.startsWith("//") ? null : url;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®",
  trade: "™", middot: "·", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", times: "×", rarr: "→", larr: "←", bull: "•", ensp: " ", emsp: " ", thinsp: " ", zwj: "‍", zwnj: "‌" };
/** Character references as the browser reads them; an unknown one stays as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z]+));/g, (written, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? written;
    const code = decimal ? Number(decimal) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

/** A heading's anchor as GitHub makes it: lower case, its marks gone, its spaces hyphens. */
export const headingAnchor = (words: string) => words.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
