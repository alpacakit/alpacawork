import { Fragment } from "react";

/** Words by sentence (`gap`: a space follows it); a bold mark's end right after a sentence's end stays with it. */
export const sentences = (words: string) => [...words.matchAll(/([^。！？.!?]+(?:[。！？.!?]+(?:<\/b>)?[)）」』”’"»]*|$))(\s*)/g)]
  .map(([, sentence = "", gap = ""]) => ({ sentence, gap: gap.length > 0 }));

/**
 * A few words to be read at a glance, each sentence kept whole on a line where it fits: a line breaks between sentences
 * before it breaks inside one, and inside one at a phrase's end, its lines of even length. Each sentence is its own
 * `span`. What the words mark `<b>…</b>` (inside one sentence) is set in bold: what the reader must not miss.
 */
export function Sentences({ words }: { words: string }) {
  return <>{sentences(words).map(({ sentence, gap }, at) =>
    <Fragment key={at}><span className="inline-block text-balance [word-break:auto-phrase]">{bold(sentence)}</span>{gap && " "}</Fragment>)}</>;
}

/** A sentence's words, those marked `<b>…</b>` in bold (every other piece as it is). */
const bold = (sentence: string) => sentence.split(/<b>(.*?)<\/b>/g)
  .map((piece, at) => at % 2 === 1 ? <strong key={at} className="font-semibold">{piece}</strong> : piece);
