/**
 * The one look of a stamp on a reader's card: what letting a swipe go would do (Send, Hold), and the admitted
 * operation (Send, Hold, Done, Stop). Their words, color and mark stay their own; the
 * paper, edge, size and the words' line are these, so a stamp added later looks the same.
 */
export const stampPaper = "rounded-lg border-[5px] border-current bg-stamp px-6 py-3 shadow-float";
export const stampWords = "flex items-center gap-2 text-seal font-extrabold whitespace-nowrap";

/** The operation keeps the same ink while previewed and while leaving. */
export const stampInk = { send: "text-done", done: "text-done", hold: "text-muted", stop: "text-stamp-stop" } as const;
