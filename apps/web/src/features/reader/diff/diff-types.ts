export type SourceLine = {
  /** UTF-16 offsets into the unchanged document text. */
  start: number;
  /** Excludes CRLF/LF; a genuine lone CR payload must not be discarded. */
  contentEnd: number;
  /** Includes the original line ending. EOS has end === contentEnd. */
  end: number;
};
type LineRange = readonly [from: number, toExclusive: number];
type FileId = number; // original first header line index
type HunkId = number; // original @@ line index
export type Change = 'change' | 'new' | 'deleted' | 'rename' | 'copy';
export type LineChange = 'add' | 'del' | 'ctx';
export type DiffHunk = {
  id: HunkId;
  oldStart: number;
  oldCount: number; // includes context, never the deletion statistic
  newStart: number;
  newCount: number; // includes context, never the addition statistic
};
export type DiffFile = {
  id: FileId;
  /** /dev/null -> null; no inferred name for pathless input. */
  oldPath: string | null;
  newPath: string | null;
  change: Change;
  mode?: { old?: string; next?: string };
  /** Count actual +/- body rows in the patch, not complete-file line arrays. */
  stats: { added: number; deleted: number };
  hunks: readonly DiffHunk[];
};
export type DiffPart =
  | { kind: 'file'; file: FileId; source: LineRange }
  | { kind: 'hunk'; file: FileId; hunk: HunkId; source: LineRange }
  | { kind: 'body'; file: FileId; hunk: HunkId; line: number; change: LineChange }
  | { kind: 'raw'; source: LineRange }; // preamble, EOF marker, blank tail: never silently swallowed

/** Produced once per text by a pure, bounded diff-source.ts owner before first render.
 * Parts partition every original line, in source order, exactly once.
 * File/hunk parts replace only positively recognized headers. Body parts always render original slices.
 * Ranges/IDs do not depend on vendor-render positions or asynchronously generated colours.
 * A text that names no file but has a +/- line is its `lines`, each one's change by its first letter (`changes`, one per
 * line): no file, name or number is inferred. Any other text (a patch it cannot read, no such line, beyond the bounds) is `raw`.
 */
export type DiffDocument =
  | { kind: 'raw'; text: string; reason: 'limit' | 'invalid' | 'pathless' | 'unsupported-format' }
  | { kind: 'lines'; text: string; lines: readonly SourceLine[]; changes: readonly LineChange[] }
  | { kind: 'structured'; text: string; lines: readonly SourceLine[]; files: readonly DiffFile[]; parts: readonly DiffPart[] };

export type StructuredDiffDocument = Extract<DiffDocument, { kind: 'structured' }>;
export type LinesDiffDocument = Extract<DiffDocument, { kind: 'lines' }>;
/** UTF-16 offsets relative to the original source line, including its prefix at zero. */
export type DiffSpan = readonly [start: number, end: number, light: string, dark: string];
/** Original line indices; only body rows can carry colour spans. */
export type DiffColours = Array<readonly DiffSpan[] | null>;
/** A whole file read in the viewer: painted by its name's language (codeLanguage), its colours its lines' from their first letter. */
export type CodeFile = { kind: 'file'; path: string; text: string };
export type DiffWorkerRequest = { kind: 'highlight'; id: number; document: StructuredDiffDocument | CodeFile } | { kind: 'cancel'; id: number };
export type DiffWorkerResponse = { id: number; colours: DiffColours | null; reason?: 'grammar-load' | 'highlight-failed'; cause?: string };
