import { Fragment } from "react";

/** Words by sentence (`gap`: a space follows it). */
export const sentences = (words: string) => [...words.matchAll(/([^。！？.!?]+(?:[。！？.!?]+[)）」』”’"»]*|$))(\s*)/g)]
  .map(([, sentence = "", gap = ""]) => ({ sentence, gap: gap.length > 0 }));

/**
 * A few words to be read at a glance, each sentence kept whole on a line where it fits: a line breaks between sentences
 * before it breaks inside one, and inside one at a phrase's end, its lines of even length. Each sentence is its own
 * `span`.
 */
export function Sentences({ words }: { words: string }) {
  return <>{sentences(words).map(({ sentence, gap }, at) =>
    <Fragment key={at}><span className="inline-block text-balance [word-break:auto-phrase]">{sentence}</span>{gap && " "}</Fragment>)}</>;
}
