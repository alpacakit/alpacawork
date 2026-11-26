import * as React from "react";
import { createPortal } from "react-dom";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { giveFocusBack, openerChain, rememberOpener } from "@/lib/focus-return";
import { useCloseOnBack } from "@/lib/close-on-back";
import { useNarrow } from "@/state/view-store";
import { useSurfaceDocument } from "@/lib/surface";
import { leaveSheet, sheetLanding, sheetMotion } from "@/lib/sheet-motion";
import { listenSheetPress, pullsFrom, type SheetPress } from "@/lib/sheet-press";
import { cn } from "@/lib/utils";
import { Button, HEAD_MARK } from "./button";
import { Icon } from "./icon";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";

/**
 * A small surface beside the element that opened it. Wide, it is a popover
 * anchored to `anchorRef`; narrow (touch), the same content comes up as a sheet
 * from the bottom of the screen, since nothing can be pointed at there.
 * Either way Esc and a press outside close it and the focus goes back to the
 * element that opened it.
 *
 * The children are drawn once, into one element of this component's own
 * (`host`), and the surface that is open puts that element inside itself. So
 * when the width crosses 700px while the popup is open, the popover and the
 * sheet swap around the same children: what is typed in them, and a save's
 * failure state, stay as they are.
 */
export function Popup({
  open,
  onOpenChange,
  anchor,
  anchorRef,
  label,
  heading,
  align = "start",
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is rendered in place, wide or narrow, when the trigger is the popup's own to draw. */
  anchor?: React.ReactNode;
  /** The trigger the popover sits under; closed menus mount only that trigger. */
  anchorRef: React.RefObject<{ getBoundingClientRect(): DOMRect } | null>;
  label: string;
  /** The label as drawn over the content, popover or sheet alike (the same words, with their parts marked); it then
   * names the surface. */
  heading?: React.ReactNode;
  align?: "start" | "center" | "end";
  /** The popover's box (its width, its padding); the sheet always spans the screen. */
  className?: string;
  children: React.ReactNode;
}) {
  // The document it opens in (the conversation's own window, when it is drawn there): its focus is what opened it.
  const page = useSurfaceDocument();
  // That window keeps a computer's sizes however narrow it is (variants.css), so it has no sheet.
  const narrow = useNarrow() && page === document;
  const [host] = React.useState(() => document.createElement("div"));
  const headingId = React.useId();
  // The element focused when this opened (and, should it go, what opened the surface it stood in), to give the
  // focus back on close. The anchor is not a Radix trigger and the sheet is mounted before it opens, so neither
  // surface can remember that itself.
  const opener = React.useRef<Element[]>([]);
  // Kept on the body and on the whole surface (its heading's buttons included), each time it is written, so whatever
  // inside reads the opener of this opening: the nearest record to an element is the one it reads.
  const remember = React.useCallback(() => {
    rememberOpener(host, opener.current);
    const surface = host.closest('[role="dialog"]');
    if (surface) rememberOpener(surface, opener.current);
  }, [host]);
  // Reattaching even to the same slot removes the focused descendant from the
  // document. Only move the host when the surface actually changes.
  const attach = React.useCallback((slot: HTMLElement | null) => {
    if (slot && host.parentNode !== slot) { slot.appendChild(host); remember(); }
  }, [host, remember]);
  const wasOpen = React.useRef(false);
  // What has the focus inside the popup, for the surface that takes over when the width crosses 700px.
  const within = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      opener.current = openerChain(page.activeElement);
      remember();
      within.current = null;
    }
    wasOpen.current = open;
  }, [open, page, remember]);
  React.useEffect(() => {
    const note = (event: FocusEvent) => { within.current = event.target as HTMLElement; };
    host.addEventListener("focusin", note);
    return () => host.removeEventListener("focusin", note);
  }, [host]);
  /**
   * The focus a surface starts with, popover or sheet alike. Taking over from the other surface, it is where it was:
   * a row being changed with the keys stays the row the keys change. Newly opened, a part marked `data-popup-focus`
   * (the chosen row of a long list) takes it, brought to the middle of what scrolls it. Else the surface's own start.
   */
  const takeFocus = React.useCallback((event: Event): boolean => {
    const kept = within.current && host.contains(within.current) ? within.current : null;
    const target = kept ?? host.querySelector<HTMLElement>("[data-popup-focus]:not(:disabled)");
    if (!target) return false;
    event.preventDefault();
    if (!kept) (target.closest("label") ?? target).scrollIntoView?.({ block: "center" });
    target.focus({ preventScroll: !kept });
    return true;
  }, [host]);
  return (
    <>
      {narrow ? (
        <>
          {anchor}
          <Sheet open={open} onOpenChange={onOpenChange} label={label} heading={heading} returnTo={opener} takeFocus={takeFocus}>
            <div ref={attach} />
          </Sheet>
        </>
      ) : (
        <Popover open={open} onOpenChange={onOpenChange}>
          <PopoverAnchor virtualRef={anchorRef} />
          {anchor}
          {open && (
            <PopoverContent {...heading ? { "aria-labelledby": headingId } : { "aria-label": label }} align={align} className={className}
              onOpenAutoFocus={(event) => {
                if (takeFocus(event)) return;
                // The first field or button that is enabled takes the focus, as the dialogs do.
                const content = event.currentTarget;
                const first = content instanceof HTMLElement ? content.querySelector<HTMLElement>(
                  ":is(input, textarea, select, button, [tabindex='0']):not(:disabled)") : null;
                if (first) { event.preventDefault(); first.focus(); }
              }}
              onCloseAutoFocus={(event) => returnFocus(event, opener)}>
              {heading && <h2 id={headingId} className={POPUP_HEADING}>{heading}</h2>}
              <div ref={attach} />
            </PopoverContent>
          )}
        </Popover>
      )}
      {createPortal(children, host)}
    </>
  );
}

/**
 * Closed, the focus goes back to what opened the popup, unless the reader has
 * already moved on: an input opened elsewhere takes the focus itself, and is
 * not robbed of it. Decided a frame later, once the closed surface is gone.
 */
function returnFocus(event: Event, returnTo: React.RefObject<readonly Element[]>) {
  event.preventDefault();
  const chain = returnTo.current;
  requestAnimationFrame(() => giveFocusBack(chain));
}

/** A popup's heading: a head's weight at its rows' size, as a menu's group names lead their rows (tokens.css). */
const POPUP_HEADING = "mb-2 text-base font-semibold [overflow-wrap:anywhere]";

/**
 * The narrow width's bottom sheet: the dialog primitive, laid along the bottom edge. It closes as every sheet on a
 * phone does: × at its head's right, its grip (and the head under it, and what it shows when a finger goes down from
 * its top) pulled down, a press on the dim around it, Esc and Back. Its height is what it holds, so a hand only takes
 * it down: let go, it closes by the rule every sheet lets go by (sheetLanding), else it goes back up.
 */
function Sheet({
  open,
  onOpenChange,
  label,
  heading,
  returnTo,
  takeFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  heading: React.ReactNode;
  /** The chain of openers read when the sheet opened (`openerChain`). */
  returnTo: React.RefObject<readonly Element[]>;
  /** The popup's own start of focus; where it has none, the sheet's first field takes it. */
  takeFocus: (event: Event) => boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  useEscapeLayer(open, ESCAPE_LAYER.popup, () => onOpenChange(false));
  // Open for a moment only: Back closes it along with the page's step. It is only drawn on a phone.
  useCloseOnBack(open, () => onOpenChange(false));
  const [surface, setSurface] = React.useState<HTMLDivElement | null>(null);
  const close = React.useRef(onOpenChange);
  close.current = onOpenChange;
  React.useEffect(() => surface ? listenToHand(surface, () => close.current(false)) : undefined, [surface]);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--layer-dialog) animate-fade bg-dim" />
        <DialogPrimitive.Content
          ref={setSurface}
          data-slot="sheet"
          aria-label={label}
          className="fixed inset-x-0 bottom-0 z-(--layer-dialog) flex max-h-[80dvh] animate-sheet flex-col border-t border-lit-line bg-raised text-ink outline-none"
          onOpenAutoFocus={takeFocus}
          onCloseAutoFocus={(event) => returnFocus(event, returnTo)}
        >
          {/* The grip and the head under it are held to take the sheet down, as a task's sheet's are (TaskSheet). */}
          <div data-task-sheet-grab data-sheet-handle className="flex-none px-4">
            <div aria-hidden="true" className="flex h-3 items-end justify-center"><span className="h-1 w-9 rounded-sm bg-line" /></div>
            <div className="flex min-h-11 items-center gap-2">
              <DialogPrimitive.Title className={heading ? cn(POPUP_HEADING, "mb-0 min-w-0 flex-1") : "sr-only"}>{heading ?? label}</DialogPrimitive.Title>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label={t("popup.close")} title={t("popup.close")}
                  className={cn(HEAD_MARK, "-mr-1.5 ml-auto text-muted")}><Icon name="close" /></Button>
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="min-h-0 overflow-auto overscroll-contain px-4 pb-6">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A finger (or a mouse on the grip) moving `surface` down: from the grip and the head (a field there aside), or from
 * what it shows once it goes down from its top (pullsFrom). It follows the finger down, never above where it stands.
 * Let go, it closes (`away`, leaving at the finger's speed) where sheetLanding sends a sheet away, else goes back up.
 */
function listenToHand(surface: HTMLElement, away: () => void) {
  const motion = sheetMotion(surface, { most: () => surface.getBoundingClientRect().height, bottom: () => innerHeight, stand: () => innerHeight });
  const unpin = () => { surface.style.height = ""; };
  const press = (pull: boolean): SheetPress => ({
    pull,
    take: () => {
      const from = surface.getBoundingClientRect().height;
      let height = from;
      motion.hold(from);
      return {
        follow: (rise) => { height = Math.max(0, Math.min(from, from + rise)); motion.follow(height); },
        release: (speed) => {
          const landing = speed === undefined ? null : sheetLanding({ height, from, speed, screen: innerHeight, rests: [from, from] });
          if (landing?.to !== "away") return motion.settle(from, unpin, () => from);
          leaveSheet(surface, speed);
          away();
        },
      };
    },
  });
  const stop = listenSheetPress(surface, (event, target) => {
    if (target.closest("[data-task-sheet-grab]")) return target.closest("input, textarea, [contenteditable=true]") ? null : { press: press(false), capture: surface };
    return pullsFrom(event, target, surface) ? { press: press(true), capture: surface } : null;
  });
  return () => { stop(); unpin(); };
}
