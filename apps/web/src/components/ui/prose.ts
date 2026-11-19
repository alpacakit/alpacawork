/**
 * Where a line of prose stops: 65ch, about 37 Japanese characters (under JLREQ's 40 for horizontal lines), unless the
 * place sets `--prose-measure` (the reader's column is itself the measure for every pane). Counted in the text's own
 * step, so set it on what holds the text at the size it is read.
 */
export const PROSE_MEASURE = "max-w-[var(--prose-measure,65ch)]";
