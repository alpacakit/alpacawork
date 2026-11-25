/** A list item: "- " bullets, or "1. " numbers; its indent (spaces), its number and its text. */
export const LIST_ITEM = /^( *)(?:- |(\d{1,9})\. )(.*)$/;

/** A thematic break (CommonMark): three or more of one of "-", "*" or "_", spaces between allowed; it is not a list item. */
export const THEMATIC_BREAK = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

export type FenceLine = { edge: "open"; language: string; nested: boolean } | { edge: "close" } | { code: string } | null;
/**
 * Fenced code as every reader of Markdown finds it (the renderer, links, diff commands), fed one line at a time:
 * a fence edge, a line inside a fence (its fence's indent left out), or null for a line outside. A fence may be indented
 * up to three spaces past where it stands: the page, or the text of the list item above it, blank lines between
 * included (CommonMark); one under an item is `nested`.
 */
export function fenceLines(): (line: string) => FenceLine {
  let fence: { indent: number } | null = null, itemIndent = 0;
  return line => {
    const indent = line.length - line.trimStart().length;
    if (line.trimStart().startsWith("```") && indent <= (fence ? fence.indent : itemIndent) + 3) {
      if (fence) { fence = null; return { edge: "close" }; }
      const nested = itemIndent > 0 && indent >= itemIndent;
      if (!nested) itemIndent = 0;
      fence = { indent };
      return { edge: "open", language: line.trimStart().slice(3).trim().split(/\s/)[0]!.toLowerCase(), nested };
    }
    if (fence) return { code: line.replace(new RegExp(`^ {0,${fence.indent}}`), "") };
    const item = !THEMATIC_BREAK.test(line) && LIST_ITEM.exec(line);
    if (item) itemIndent = line.length - item[3]!.length;
    else if (line.trim()) itemIndent = 0;
    return null;
  };
}
