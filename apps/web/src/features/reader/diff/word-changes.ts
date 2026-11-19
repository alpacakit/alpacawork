/**
 * What changed between a removed line and the line added in its place, word by word, for a report diff's card: a
 * Japanese paragraph is one line, so a sentence added to it would otherwise be the whole paragraph twice. Pure and
 * bounded: the part both lines share at their start and end is set aside by letters first (an added sentence costs no
 * more than reading the lines), and only what is left is compared by words (Intl.Segmenter), and only while it is small;
 * beyond WORD_LIMITS what is left is one change.
 */

export type WordPiece = { kind: "same" | "add" | "del"; text: string };

/** How many words each side's middle may hold, and how many word pairs may be compared, before the middle is one change. */
export const WORD_LIMITS = { words: 600, pairs: 120_000 } as const;
/** A word both sides share between two changes, this short or shorter, is read as part of the change (a Japanese particle or comma): fewer pieces. */
const ISLAND = 1;

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
const words = (text: string) => Array.from(segmenter.segment(text), part => part.segment);

/** Whether `at` splits a surrogate pair of `text`: a cut there would leave half a letter on each side. */
const halves = (text: string, at: number) => at > 0 && at < text.length &&
  /[\uDC00-\uDFFF]/.test(text[at]!) && /[\uD800-\uDBFF]/.test(text[at - 1]!);

/** How much of their words two lines must share to read as one line changed rather than one removed and another added. */
export const SIMILAR = 0.5;

/**
 * Whether `after` reads as `before` changed: the words both hold (word-like segments, counted with repeats) make up at
 * least SIMILAR of all their words (Dice). Linear in the lines' length. An empty or blank line is like nothing.
 */
export function similar(before: string, after: string): boolean {
  const counts = new Map<string, number>();
  let total = 0, shared = 0;
  for (const part of segmenter.segment(before)) if (part.isWordLike) { counts.set(part.segment, (counts.get(part.segment) ?? 0) + 1); total++; }
  for (const part of segmenter.segment(after)) if (part.isWordLike) {
    total++;
    const left = counts.get(part.segment) ?? 0;
    if (left) { counts.set(part.segment, left - 1); shared++; }
  }
  return total > 0 && 2 * shared / total >= SIMILAR;
}

/** The pieces of `before` and `after` in reading order: same, then removed and added where they differ. */
export function wordChanges(before: string, after: string): WordPiece[] {
  let start = 0;
  const shortest = Math.min(before.length, after.length);
  while (start < shortest && before[start] === after[start]) start++;
  while (halves(before, start)) start--;
  let end = 0;
  while (end < shortest - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  while (halves(before, before.length - end)) end--;
  const pieces: WordPiece[] = [];
  push(pieces, "same", before.slice(0, start));
  middle(pieces, before.slice(start, before.length - end), after.slice(start, after.length - end));
  push(pieces, "same", before.slice(before.length - end));
  return absorbIslands(pieces);
}

function push(pieces: WordPiece[], kind: WordPiece["kind"], text: string) {
  if (!text) return;
  const last = pieces.at(-1);
  if (last?.kind === kind) last.text += text;
  else pieces.push({ kind, text });
}

/** The differing middle: by words while it is small (the longest run of words both share), else one change. */
function middle(pieces: WordPiece[], before: string, after: string) {
  if (!before || !after) { push(pieces, "del", before); push(pieces, "add", after); return; }
  const a = words(before), b = words(after);
  if (a.length > WORD_LIMITS.words || b.length > WORD_LIMITS.words || a.length * b.length > WORD_LIMITS.pairs) {
    push(pieces, "del", before); push(pieces, "add", after); return;
  }
  // Longest common subsequence of words, read from the end so the walk below goes forward.
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1
      : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  }
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push(pieces, "same", a[i]!); i++; j++; }
    else if (j === b.length || (i < a.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { push(pieces, "del", a[i]!); i++; }
    else { push(pieces, "add", b[j]!); j++; }
  }
}

/** A short shared word between changes joins them, so a change reads as one phrase rather than letter by letter. */
function absorbIslands(pieces: WordPiece[]): WordPiece[] {
  return regroup(pieces.flatMap((piece, k) => piece.kind === "same" && k > 0 && k < pieces.length - 1 &&
    [...piece.text].length <= ISLAND ? [{ kind: "del" as const, text: piece.text }, { kind: "add" as const, text: piece.text }] : [piece]));
}

/** Between two shared runs, the removed words first and the added after, each as one piece. */
function regroup(pieces: WordPiece[]): WordPiece[] {
  const out: WordPiece[] = [];
  let del = "", add = "";
  const flush = () => { if (del) out.push({ kind: "del", text: del }); if (add) out.push({ kind: "add", text: add }); del = add = ""; };
  for (const piece of pieces) {
    if (piece.kind === "del") del += piece.text;
    else if (piece.kind === "add") add += piece.text;
    else { flush(); out.push(piece); }
  }
  flush();
  return out;
}

/** An excerpt's pieces: a shared run longer than `context` letters keeps only its letters next to a change, with … for the rest. */
export type ExcerptPiece = WordPiece | { kind: "gap" };
export function excerpt(pieces: WordPiece[], context = 40): ExcerptPiece[] {
  const out: ExcerptPiece[] = [];
  pieces.forEach((piece, k) => {
    if (piece.kind !== "same") { out.push(piece); return; }
    const letters = [...piece.text];
    const first = k === 0, last = k === pieces.length - 1;
    if (first && last) { out.push(piece); return; }
    const keep = first || last ? context : context * 2;
    if (letters.length <= keep + 1) { out.push(piece); return; }
    if (first) { out.push({ kind: "gap" }, { kind: "same", text: letters.slice(-context).join("") }); return; }
    if (last) { out.push({ kind: "same", text: letters.slice(0, context).join("") }, { kind: "gap" }); return; }
    out.push({ kind: "same", text: letters.slice(0, context).join("") }, { kind: "gap" }, { kind: "same", text: letters.slice(-context).join("") });
  });
  return out;
}
