import { markdownDocument as parseMarkdown } from "@alpacawork/contract/markdown";

export * from "@alpacawork/contract/markdown";

type Parsed = ReturnType<typeof parseMarkdown>;
/** A parse shared by every reader of the same body: none of them can change it. */
type MarkdownDocument = { readonly blocks: readonly Parsed["blocks"][number][]; readonly media: readonly Parsed["media"][number][] };
/** How many bodies' parses are kept, the most recently used: more than a History page and the bodies open beside it. */
const KEPT_DOCUMENTS = 200;
/** A body longer than this is parsed each time rather than kept. */
const KEPT_TEXT_LENGTH = 100_000;
const kept = new Map<string, MarkdownDocument>();

/**
 * `markdownDocument` of the contract, parsed once per body: a History's gallery and an open row's body read the same
 * text, and each read of the page or redraw of a row parsed it again. What it returns is shared, so no caller changes it.
 */
export function markdownDocument(text: string): MarkdownDocument {
  const held = kept.get(text);
  if (held) { kept.delete(text); kept.set(text, held); return held; }
  const parsed = parseMarkdown(text);
  if (text.length > KEPT_TEXT_LENGTH) return parsed;
  kept.set(text, parsed);
  if (kept.size > KEPT_DOCUMENTS) kept.delete(kept.keys().next().value!);
  return parsed;
}

export const markdownMedia = (text: string) => markdownDocument(text).media;
