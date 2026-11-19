import { isHtml } from "./files/HtmlFrame";

/**
 * What the reader shows to be read stands in one column at every width: the reports, a document or the folder's
 * sheet, About, the body being edited, and their skeletons. The reader draws the column once around whichever pane is
 * open, so no pane sets its own width. It is as wide as the reader up to `--reading-column` (styles.css), and stands in
 * the middle beyond it; its text fills it, so the column is the measure. What it holds keeps its own way with a long
 * line: a table or a row of pictures scrolls sideways inside it, a code block wraps. The big title above it starts and
 * ends where the column does; the scroller's 1rem sides are the least. The title's percentage is of the scroller's inner
 * width, so it adds back the scroller's 1rem.
 * The head's row (Back, the path, the window's buttons) belongs to the window, not to what is read, and keeps its edges.
 */
export const COLUMN = {
  body: "mx-auto w-full max-w-(--reading-column) [--prose-measure:none]",
  title: "px-[max(1rem,calc((100%-var(--reading-column))/2+1rem))]",
};

/**
 * An HTML page lays itself out for the width it is given, so it takes the reader's whole width instead of the column.
 * (A picture or a video in the files opens in the image viewer over the screen, never as the shown file.)
 */
export const looksWide = (path: string | null) => !!path && isHtml(path);
