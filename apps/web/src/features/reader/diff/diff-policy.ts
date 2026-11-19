import type { FileDiffMetadata, HunksRenderResult } from "@pierre/diffs";
import type { DiffColours, DiffPart, DiffSpan, StructuredDiffDocument } from "./diff-types";
import { codeLanguage, type CodeLanguage } from "./diff-languages";
import { acceptsDiffInput, DIFF_LIMITS } from "@alpacawork/contract/report-diff";
import { hunkBoundary } from "./diff-source";

type SourceRow = { index: number; kind: "add" | "del" | "ctx"; content: string };
type SourceFile = { rows: Map<string, SourceRow> };
type DiffPlan = { file: FileDiffMetadata; language: CodeLanguage; source: SourceFile };
const endOfLine = (line: string) => line.replace(/\r?\n$/, "");
const rowKey = (side: "old" | "new", number: number) => `${side}:${number}`;

/** Check the immutable source projection before trusting any row index received by the Worker. */
function corresponds(document: StructuredDiffDocument): boolean {
  let offset = 0, index = 0;
  for (const line of document.lines) {
    const lf = document.text.indexOf("\n", offset);
    const end = lf < 0 ? document.text.length : lf + 1;
    const contentEnd = lf < 0 ? end : lf - (document.text[lf - 1] === "\r" ? 1 : 0);
    if (line.start !== offset || line.contentEnd !== contentEnd || line.end !== end) return false;
    offset = end;
  }
  if (offset !== document.text.length || document.lines.length !== document.text.split("\n").length) return false;
  for (const part of document.parts) {
    const from = part.kind === "body" ? part.line : part.source[0];
    const to = part.kind === "body" ? from + 1 : part.source[1];
    if (from !== index || !Number.isInteger(to) || to <= from || to > document.lines.length) return false;
    index = to;
  }
  return index === document.lines.length;
}

/**
 * Prove vendor/source correspondence, then plan each file whose name has a language. Display stays canonical. The
 * renderer reads a patch's hunks one by one, each from the grammar's start: a hunk that begins inside a comment or a
 * string the file opened above it is painted as code until that ends (the lines above are not in the patch).
 */
export function planDiff(document: StructuredDiffDocument, files: FileDiffMetadata[]): DiffPlan[] {
  const { text } = document;
  const units = files.reduce((n, file) => n + file.additionCharacterCount + file.deletionCharacterCount, 0);
  const count = files.reduce((n, file) => n + file.additionLines.length + file.deletionLines.length, 0);
  if (!acceptsDiffInput(text) || units > DIFF_LIMITS.sourceUnits || count > DIFF_LIMITS.lines
    || !corresponds(document) || files.length !== document.files.length) return [];
  const line = (index: number) => { const source = document.lines[index]; return source ? text.slice(source.start, source.contentEnd) : ""; };
  const partsByFile = new Map<number, DiffPart[]>();
  for (const part of document.parts) {
    if (part.kind === "raw") continue;
    const parts = partsByFile.get(part.file);
    if (parts) parts.push(part);
    else partsByFile.set(part.file, [part]);
  }
  const plans: DiffPlan[] = [];
  for (const [index, sourceFile] of document.files.entries()) {
    const file = files[index]!;
    const parts = partsByFile.get(sourceFile.id) ?? [];
    const firstPart = parts.find(part => part.kind === "file");
    if (!firstPart || firstPart.kind !== "file" || firstPart.source[0] !== sourceFile.id
      || (index > 0 && sourceFile.id <= document.files[index - 1]!.id)) return [];
    const name = sourceFile.newPath ?? sourceFile.oldPath;
    if (!name || file.name !== name
      || (file.prevName !== undefined && (sourceFile.oldPath === null || file.prevName !== sourceFile.oldPath))
      || file.hunks.length !== sourceFile.hunks.length) return [];
    const rows = new Map<string, SourceRow>();
    const body = parts.filter(part => part.kind === "body");
    const headers = parts.filter(part => part.kind === "hunk");
    if (headers.length !== sourceFile.hunks.length) return [];
    let bodyIndex = 0;
    for (const [hunkIndex, sourceHunk] of sourceFile.hunks.entries()) {
      const hunk = file.hunks[hunkIndex]!;
      const header = headers[hunkIndex]!;
      if (header.kind !== "hunk" || header.hunk !== sourceHunk.id || header.source[0] !== sourceHunk.id || header.source[1] !== sourceHunk.id + 1
        || sourceHunk.oldStart !== hunk.deletionStart || sourceHunk.oldCount !== hunk.deletionCount
        || sourceHunk.newStart !== hunk.additionStart || sourceHunk.newCount !== hunk.additionCount
        || !hunk.hunkSpecs || line(sourceHunk.id) !== endOfLine(hunk.hunkSpecs)) return [];
      let old = 0, next = 0, oldEOF = false, newEOF = false;
      while (old < hunk.deletionCount || next < hunk.additionCount) {
        const part = body[bodyIndex++];
        if (!part || part.kind !== "body" || part.hunk !== sourceHunk.id || part.line <= sourceHunk.id) return [];
        const raw = line(part.line), kind = part.change;
        if (raw[0] !== (kind === "add" ? "+" : kind === "del" ? "-" : " ")) return [];
        const row: SourceRow = { index: part.line, kind, content: raw.slice(1) };
        if (line(part.line + 1) === "\\ No newline at end of file") {
          if (kind !== "add") oldEOF = true;
          if (kind !== "del") newEOF = true;
        }
        for (const side of ["old", "new"] as const) {
          if ((side === "old" && kind === "add") || (side === "new" && kind === "del")) continue;
          const position = side === "old" ? old++ : next++;
          const saved = side === "old" ? file.deletionLines[hunk.deletionLineIndex + position] : file.additionLines[hunk.additionLineIndex + position];
          const count = side === "old" ? hunk.deletionCount : hunk.additionCount;
          const start = side === "old" ? hunk.deletionStart : hunk.additionStart;
          const key = rowKey(side, hunkBoundary(start, count) + position + 1);
          if (position >= count || saved === undefined || endOfLine(saved) !== row.content || rows.has(key)) return [];
          rows.set(key, row);
        }
      }
      if (hunk.noEOFCRDeletions !== oldEOF || hunk.noEOFCRAdditions !== newEOF) return [];
    }
    if (bodyIndex !== body.length) return [];
    const language = codeLanguage(name);
    if (!language || [sourceFile.oldPath, sourceFile.newPath].some(path => path !== null && codeLanguage(path) !== language)) continue;
    plans.push({ file: { ...file, lang: language.id as FileDiffMetadata["lang"] }, language, source: { rows } });
  }
  return plans;
}

type AstNode = NonNullable<HunksRenderResult["unifiedContentAST"]>[number];
/** A colour a token may carry: a hex colour, nothing a style could be made to do more with. */
export const colour = /^#[\da-f]{3,8}$/i;
/** Read public render output only. Row number/type + exact text prove every returned offset. */
export function coloursFromAST(plan: DiffPlan, result: HunksRenderResult, target: DiffColours): void {
  const seen = new Set<number>();
  function row(node: AstNode): void {
    if (node.type !== "element") return;
    const number = node.properties["data-line"];
    const lineType = node.properties["data-line-type"];
    if (typeof number !== "number" || typeof lineType !== "string") { node.children.forEach(row); return; }
    const kind = lineType === "change-deletion" ? "del" : lineType === "change-addition" ? "add" : lineType === "context" ? "ctx" : null;
    if (!kind) return;
    const source = plan.source.rows.get(rowKey(kind === "del" ? "old" : "new", number));
    if (!source || source.kind !== kind || seen.has(source.index)) throw new Error("Rendered diff row has no unique source line");
    seen.add(source.index);
    const spans: DiffSpan[] = [];
    let text = "";
    function visit(part: AstNode, light?: string, dark?: string): void {
      if (part.type === "element") {
        const style = part.properties.style;
        if (typeof style === "string") for (const declaration of style.split(";")) {
          const at = declaration.indexOf(":");
          const name = declaration.slice(0, at), value = declaration.slice(at + 1);
          if (name === "--diffs-token-light") light = value;
          if (name === "--diffs-token-dark") dark = value;
        }
        part.children.forEach(child => visit(child, light, dark));
      } else if (part.type === "text") {
        const start = text.length + 1;
        text += part.value;
        if (part.value && light && dark && colour.test(light) && colour.test(dark)) spans.push([start, text.length + 1, light, dark]);
      }
    }
    visit(node);
    // Translate the public renderer's empty-line placeholder, never a source token.
    if (source.content === "" && text === "\n") { text = ""; spans.length = 0; }
    if (text !== source.content) throw new Error("Rendered diff text does not equal original source line");
    if (source.content === "" || spans.length) target[source.index] = spans;
  }
  result.unifiedContentAST?.forEach(row);
}
