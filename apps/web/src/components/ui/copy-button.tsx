import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeClip, type Clip } from "@/lib/clipboard";
import { useSurfaceDocument } from "@/lib/surface";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Icon } from "./icon";

/** How long the ✓ stays. It comes in as a press that landed (`animate-pop`, styles.css's motion). */
const COPIED_MS = 1600;

/**
 * A copy mark that says it worked where it was pressed: the mark turns to ✓ for a moment, on a phone as on a
 * computer, instead of a toast far from the finger. A failure still says what to do instead (`writeClip`).
 * `clip` is read at the press, so it is what the screen shows then: a text as it is (`textClip`), or words with
 * references (`piecesClip`). It copies through the window it is drawn in (the coordinator's conversation can be in a
 * window of its own). With `words`, it is a framed button that says what it copies beside its mark (its label), and says
 * it worked in those words too: the one shape of a copy that stands among other words.
 */
export function CopyButton({ clip, label, words = false, className }: { clip: () => Clip; label: string; words?: boolean; className?: string }) {
  const { t } = useTranslation("ui");
  const [copied, copy] = useCopy(clip);
  const name = copied ? t("copied") : label;
  return <Button variant={words ? "outline" : "quiet"} size={words ? "default" : "icon"} data-copy={copied ? "done" : ""} aria-label={name} title={name}
    className={cn(words ? "shrink-0 text-muted hover:text-ink active:bg-press narrow:min-h-11" : "text-muted hover:text-ink", className)}
    onClick={copy}>
    <CopyMark copied={copied} />
    {words && <span>{name}</span>}
  </Button>;
}

/** The copy's mark: ✓ for a moment once it worked. */
export function CopyMark({ copied }: { copied: boolean }) {
  return copied ? <Icon key="check" name="check" className="size-3.5 animate-pop" /> : <Icon key="copy" name="copy" className="size-3.5" />;
}

/**
 * A copy pressed in place, and whether it just worked (for the ✓ it shows a moment): every copy mark's one behaviour,
 * whatever its face. It copies through the window it is drawn in.
 */
export function useCopy(clip: () => Clip): [copied: boolean, copy: () => void] {
  const view = useSurfaceDocument().defaultView ?? window;
  return useWorked(() => writeClip(clip(), { said: false, view }));
}

/**
 * A press that says it worked where it was pressed, and whether it just did (for the ✓ it shows a moment): a press
 * clears the last ✓; only this press's success sets it (one a later press overtook comes to false).
 */
export function useWorked(act: () => boolean | Promise<boolean>): [worked: boolean, press: () => void] {
  const [worked, setWorked] = useState(false);
  useEffect(() => {
    if (!worked) return;
    const timer = window.setTimeout(() => setWorked(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [worked]);
  return [worked, () => { setWorked(false); void Promise.resolve(act()).then(ok => { if (ok) setWorked(true); }); }];
}
