import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";

type FrontMatterIssue = "unclosed" | "invalid" | "unsupported" | "limit";
type FrontMatter =
  | { kind: "none"; body: string }
  | { kind: "parsed"; raw: string; body: string; rows: { key: string; value: string }[] }
  | { kind: "fallback"; raw: string; body: string; issue: FrontMatterIssue };

// These are display limits, below the file reader's byte limit. Fallback always keeps the whole source.
const MAX_SOURCE = 65_536;
const MAX_ROWS = 200;
const MAX_NODES = 2_000;
const MAX_DEPTH = 20;

/** File metadata only: the shared Markdown grammar has no front-matter semantics. */
export function frontMatter(text: string): FrontMatter {
  const start = /^\uFEFF?---\r?\n/.exec(text);
  if (!start) return { kind: "none", body: text };
  const endPattern = /(?<=\n)---(?:\r?\n|$)/g;
  endPattern.lastIndex = start[0].length;
  const end = endPattern.exec(text);
  if (!end) return { kind: "fallback", raw: text, body: "", issue: "unclosed" };
  const raw = text.slice(0, end.index + end[0].length);
  const body = text.slice(raw.length);
  const source = text.slice(start[0].length, end.index);
  const fallback = (issue: FrontMatterIssue): FrontMatter => ({ kind: "fallback", raw, body, issue });
  if (source.length > MAX_SOURCE) return fallback("limit");
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(source, { version: "1.2", schema: "core", uniqueKeys: true, prettyErrors: false });
  } catch (error) {
    // Pathologically deep input can exhaust the composer's stack before our AST bound is reached.
    if (error instanceof RangeError) return fallback("limit");
    throw error;
  }
  if (doc.errors.length) return fallback("invalid");
  if (doc.warnings.length) return fallback("unsupported");
  if (doc.contents === null) return { kind: "parsed", raw, body, rows: [] };
  if (!isMap(doc.contents)) return fallback("unsupported");
  if (doc.contents.items.length > MAX_ROWS) return fallback("limit");

  // Walk syntax nodes only. Aliases remain references, including cyclic ones; never expand into JS.
  const pending: { node: unknown; depth: number }[] = [{ node: doc.contents, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > MAX_NODES || depth > MAX_DEPTH) return fallback("limit");
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) return fallback("unsupported");
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
    } else if (isAlias(node) && !node.resolve(doc)) return fallback("invalid");
  }
  const valueText = (node: unknown): string => {
    if (node === null) return "";
    let value: string;
    if (isScalar(node)) {
      value = typeof node.value === "string" ? node.value : node.source ?? String(node.value);
    } else {
      // Keep nested YAML and alias spellings, without serializing or expanding references.
      const range = (node as Node).range!;
      const indentation = source.slice(source.lastIndexOf("\n", range[0] - 1) + 1, range[0]);
      const nested = source.slice(range[0], range[1]).trimEnd();
      value = /^ +$/.test(indentation) ? nested.split("\n").map((line, index) =>
        index > 0 && line.startsWith(indentation) ? line.slice(indentation.length) : line).join("\n") : nested;
    }
    const anchor = (isScalar(node) || isMap(node) || isSeq(node)) && node.anchor;
    return anchor ? `&${anchor} ${value}` : value;
  };
  return { kind: "parsed", raw, body, rows: doc.contents.items.map(pair => ({ key: valueText(pair.key), value: valueText(pair.value) })) };
}
