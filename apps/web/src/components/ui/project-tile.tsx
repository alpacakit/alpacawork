import { memo, useMemo, type CSSProperties } from "react";
import { inkOn, markLetters } from "@/domain/project-mark";
import { cn } from "@/lib/utils";

/**
 * The sizes a project's square is drawn at: a label and a list row (16: the phone row's state mark's size, a step over the
 * computer row's 14, so the square no longer outweighs the mark beside it), the reader's path and a label's card (18), the project menu (20), the list's name (24), the project window's head (28), the colour's preview (32).
 */
type ProjectTileSize = 16 | 18 | 20 | 24 | 28 | 32;

/**
 * A project's mark, one part for every place that draws it. The square is the project's colour; its letters come from
 * its name (markLetters) in white or black, whichever stands out more; a thin inner line in the theme's border colour keeps
 * the square's shape on any ground. It says nothing to a reader by itself: the place it stands in names the project (the
 * row's title, the reader's path, a label's name), or gives it `label`.
 *
 * The letters sit in the middle of the square, up and down too (the user's ask): the text box is trimmed to the capitals and
 * the baseline, so no line height or ascender room lifts them; a kana or kanji, drawn a little above the capitals' middle,
 * is set 0.03em lower (measured on the screen at 16, 18, 20, 24, 28 and 32 px: within 0.5 px of the middle). A browser
 * without `text-box` draws them on the line box's middle, about 1–2 px high.
 */
export const ProjectTile = memo(function ProjectTile({ name, color, size, label, quiet, className }: {
  name: string; color: string; size: ProjectTileSize;
  /**
   * Where the square repeats down a list (a row's): the project's colour laid thin over the ground, its letters in ink,
   * so the hue still tells the projects apart and the row's state mark and title lead.
   */
  quiet?: boolean;
  /** What a reader hears and a pointer shows, where nothing beside the square names the project. */
  label?: string;
  className?: string;
}) {
  const ink = useMemo(() => inkOn(color), [color]);
  const letters = markLetters(name);
  const latin = /^[A-Z0-9]+$/.test(letters);
  const style: CSSProperties = {
    width: size, height: size, borderRadius: Math.round(size / 4),
    ...quiet ? { background: `color-mix(in oklab, ${color} 50%, var(--bg))`, color: "var(--ink)" } : { background: color, color: ink },
    fontSize: latin && letters.length > 1 ? Math.max(9, size * 0.55) : size * 0.64,
  };
  return <span data-project-tile={letters} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    title={label} style={style}
    className={cn("inline-flex flex-none items-center justify-center font-bold ring-1 ring-line ring-inset select-none", className)}>
    {/* Drawn, not written: the letters stay out of the text around them (a row's or the list name's words, a copy). */}
    <span data-letters={letters} className={cn("cap-box before:content-[attr(data-letters)]",
      !latin && "relative top-[0.03em]")} />
  </span>;
});
