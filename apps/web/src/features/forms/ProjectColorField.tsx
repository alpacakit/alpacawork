import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HexColorPicker } from "react-colorful";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isComposingKey } from "@/components/ui/composing";
import { ProjectTile } from "@/components/ui/project-tile";
import { MARK_SWATCHES, shortOrFullColor, sixDigitColor } from "@/domain/project-mark";
import { cn } from "@/lib/utils";

/**
 * A project's colour, as the project window sets it (making a project and changing one). It shows the mark the
 * colour gives the name, the often-used colours (one row; four by two on a phone, 44px each), and Other colours…, which
 * opens a free choice in place, in the window and its theme: a saturation and value plane with a hue strip, and the
 * colour's code.
 *
 * This is the one place a colour is made regular (design v2 §1): the code field shows what is typed; only six lowercase
 * hex digits leave it (`value`, `onChange`). While typing, the colour is taken when six digits are there; three are taken,
 * doubled, when the field is left or Enter is pressed. Until a colour is taken the mark keeps the one before the typing.
 */
export function ProjectColorField({ id, name, value, onChange, labelledBy, className }: {
  /** The field's ID, on its group: the window's label names it. */
  id?: string;
  /** The project's name, whose letters the preview draws. */
  name: string;
  /** The colour taken: `#rrggbb`. */
  value: string;
  onChange: (color: string) => void;
  /** The field's label (the window's "Colour"). */
  labelledBy?: string;
  className?: string;
}) {
  const { t } = useTranslation("forms");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(value);
  const typing = useRef(false);
  const code = useRef<HTMLInputElement>(null);
  const codeId = useId(), paletteId = useId();
  // A colour taken elsewhere (a swatch, the plane) is what the field shows, unless it is being typed into.
  useEffect(() => { if (!typing.current) setTyped(value); }, [value]);
  // Opened, the free choice is brought into view in the window, its code field too, so the window's own end (Create,
  // Save) is a scroll away rather than the choice being out of sight.
  useEffect(() => { if (open) code.current?.scrollIntoView({ block: "nearest" }); }, [open]);
  // Each colour's name, said for its swatch; written out so the words are found where they are used.
  // t changes with the active language; name and colour edits can reuse these words.
  const swatchName = useMemo<Record<(typeof MARK_SWATCHES)[number]["key"], string>>(() => ({
    navy: t("projectColor.swatch.navy"), lime: t("projectColor.swatch.lime"), brown: t("projectColor.swatch.brown"),
    violet: t("projectColor.swatch.violet"), green: t("projectColor.swatch.green"), indigo: t("projectColor.swatch.indigo"),
    grape: t("projectColor.swatch.grape"), teal: t("projectColor.swatch.teal"),
  }), [t]);
  const custom = !MARK_SWATCHES.some((swatch) => swatch.color === value);
  const settle = () => {
    typing.current = false;
    const color = shortOrFullColor(typed);
    if (color) { setTyped(color); if (color !== value) onChange(color); } else setTyped(value);
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter takes the code; it does not send the window's form.
    if (event.key === "Enter" && !isComposingKey(event)) { event.preventDefault(); settle(); }
  };
  return <div data-project-color className={cn("flex min-w-0 flex-col gap-3", className)}>
    <div id={id} role="group" aria-labelledby={labelledBy} className="flex min-w-0 flex-wrap items-center gap-3">
      <ProjectTile name={name} color={value} size={32} />
      <div data-project-swatches className="grid grid-cols-8 narrow:grid-cols-4">
        {MARK_SWATCHES.map((swatch) => <button key={swatch.key} type="button" data-swatch={swatch.key}
          aria-pressed={swatch.color === value} aria-label={swatchName[swatch.key]} title={swatchName[swatch.key]}
          onClick={() => onChange(swatch.color)}
          className="grid size-9 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ink/40 narrow:size-11">
          <span className={cn("block size-[26px] rounded-[7px] ring-1 ring-line ring-inset",
            swatch.color === value && "ring-2 ring-ink ring-offset-2 ring-offset-raised")} style={{ background: swatch.color }} />
        </button>)}
      </div>
      <Button type="button" variant="outline" data-project-color-more aria-expanded={open} aria-controls={paletteId}
        onClick={() => setOpen((was) => !was)} className={cn("gap-2", custom && "ring-2 ring-ink")}>
        <span aria-hidden="true" className="block size-3.5 rounded-full ring-1 ring-line ring-inset"
          style={{ background: custom ? value : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }} />
        {t("projectColor.more")}
      </Button>
    </div>
    {open && <div id={paletteId} data-project-palette className="flex max-w-80 flex-col gap-2">
      <HexColorPicker color={value} onChange={(color) => { typing.current = false; onChange(color); }}
        className="!h-40 !w-full [&_.react-colorful\_\_hue]:!h-4 [&_.react-colorful\_\_hue]:!rounded-b-md [&_.react-colorful\_\_pointer]:!size-6 [&_.react-colorful\_\_saturation]:!rounded-t-md [&_.react-colorful\_\_saturation]:!border-b-0" />
      <label htmlFor={codeId} className="flex items-center gap-2 text-sm text-muted">
        {t("projectColor.code")}
        <Input ref={code} id={codeId} data-project-color-code value={typed} spellCheck={false} autoComplete="off" maxLength={7}
          onChange={(event) => {
            typing.current = true;
            setTyped(event.target.value);
            const color = sixDigitColor(event.target.value);
            if (color && color !== value) onChange(color);
          }}
          onBlur={settle} onKeyDown={keys} className="w-28 font-mono tabular-nums" />
      </label>
    </div>}
  </div>;
}
