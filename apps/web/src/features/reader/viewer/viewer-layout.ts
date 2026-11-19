/**
 * How the viewer lays out what it read, from its size alone (pure): whatever opened it (a report's summary, the Files
 * tab, a path in a report, a reload of its URL), the same document lays out the same way. Every bound by count or size
 * is here, in VIEWER_BOUNDS.
 */
export const VIEWER_BOUNDS = {
  /**
   * Up to this many pages and changed lines, every page starts open: about four phone screens of rows, so reading it
   * through costs less than opening its files one by one. A larger one starts on its closed headings.
   */
  openPages: 20,
  openLines: 300,
  /**
   * From this width of the diff's frame (a computer), a diff that changes code is read side by side: each half then holds
   * about 60 letters of code before it folds, as a line of code is mostly written. Narrower, one above the other.
   */
  splitWidth: 1100,
  /**
   * The same for a diff that changes only documents: a paragraph side by side keeps about 30 Japanese letters a line on
   * each side, which reads as a column of a page does; one above the other it would run past what an eye follows.
   */
  proseSplitWidth: 880,
} as const;

/**
 * Whether a computer reads a diff side by side: as its reader chose (`chosen`), else by the width of its frame, with
 * the bound of what the diff changes (`code`: any code file both removes and adds lines; else only documents). One
 * answer for the whole diff, whatever is drawn in it now: its documents as they read or by their lines, its code files,
 * so switching how documents are shown never moves a side. `frame` is the frame's whole width, its scrollbar's too, so
 * a scrollbar coming and going with what is drawn does not either.
 */
export function readsSideBySide(chosen: boolean | null, frame: number, code: boolean): boolean {
  return chosen ?? frame >= (code ? VIEWER_BOUNDS.splitWidth : VIEWER_BOUNDS.proseSplitWidth);
}

/**
 * The least width a diff or a file takes in the list's place beside the docked reader on a computer: about 80 letters of
 * code one above the other with its line numbers. Narrower, the reader takes the whole screen and it is read over the
 * reports, so the reader is never squeezed to make room for it.
 */
export const VIEW_BESIDE_WIDTH = 640;

/**
 * - `open`: every page starts open; else every page starts closed. A single page always starts open: it has no heading
 *   to open it by.
 * - `heads`: each page under its own heading. A single page has none: the viewer's title names it.
 */
export type ViewerLayout = { open: boolean; heads: boolean };

/** `pages`: how many pages (a diff's files; a file is one). `lines`: the lines it changes (a diff) or holds (a file). */
export function viewerLayout(pages: number, lines: number): ViewerLayout {
  const single = pages <= 1;
  return {
    open: single || pages <= VIEWER_BOUNDS.openPages && lines <= VIEWER_BOUNDS.openLines,
    heads: !single,
  };
}
