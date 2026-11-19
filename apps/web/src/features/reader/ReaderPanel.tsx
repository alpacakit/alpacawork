import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useReaderIndex } from "@/data/queries";
import type { Task } from "@/data/types";
import { PhoneSheet, sheetExtent } from "@/features/coordinator/PhoneSheet";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { useNarrow } from "@/state/view-store";
import { relatedListsOf } from "./related-lists";
import { FamilyTree } from "./FamilyTree";
import { OrderList } from "./StartOrder";
import { hideReaderPanel, panelSlot, useReaderPanel } from "./reader-panel";
import { OPEN_GAP, useBesidePlace, useOpenPlace, useUnderPlace } from "./reader-panel-place";
import { useScreenHeight } from "./TaskSheet";

export type PanelForm = "sheet" | "beside" | "under";
export function ReaderPanelSlot() { return <div data-reader-panel-slot ref={panelSlot} />; }
// Preserve the tree's saved height; every related-task list uses that same sheet.
const panelExtent = sheetExtent("alpacawork.familyExtent");

/** One surface, place and lifetime for the reader's tree and dependencies. Back follows the reader;
 * navigation leaves the chosen list open. Only its entry, ×, Esc, sheet gesture or closing the reader closes it. */
export function ReaderPanel({ task, onFollow }: { task: Task; onFollow: (id: string) => void }) {
  const { t } = useTranslation("reader");
  const narrow = useNarrow();
  const kind = useReaderPanel(state => state.kind);
  const index = useReaderIndex(task);
  const lists = kind !== null ? relatedListsOf(task, index) : null;
  const open = kind !== null && lists?.[kind] != null;
  const room = Math.round(useScreenHeight() * 0.88);
  useEscapeLayer(open, ESCAPE_LAYER.popup, hideReaderPanel);
  const place = useOpenPlace(open);
  const beside = useBesidePlace(open && !narrow);
  const under = useUnderPlace(open && !narrow && !beside);
  const surface = useRef<HTMLElement | null>(null), lastKind = useRef(kind);
  useEffect(() => {
    if (kind) { lastKind.current = kind; return; }
    if (surface.current && (document.activeElement === document.body || surface.current.contains(document.activeElement)))
      useReaderPanel.getState().entries[lastKind.current!]?.focus({ preventScroll: true });
    surface.current = null;
  }, [kind]);
  if (!open || !kind || !place) return null;
  const root = lists?.family?.root;
  const pick = (id: string) => { if (id !== task.id) onFollow(id); };
  const title = t(kind === "family" ? "family.title" : "entries.dependencies");
  const body = (form: PanelForm) => kind === "family"
    ? root && <FamilyTree key={root.id} form={form} root={root} current={task.id} index={index} onPick={pick} onClose={hideReaderPanel} />
    : <OrderList key={`${kind}:${task.id}`} task={task} form={form} onFollow={pick} onClose={hideReaderPanel} />;
  const keep = (element: HTMLElement | null) => { if (element) surface.current = element; };
  if (narrow) return createPortal(
    <PhoneSheet ref={keep} role="dialog" aria-modal={false} aria-label={title} data-reader-panel={kind}
      data-family-sheet={kind === "family" ? "" : undefined}
      label={kind === "family" ? t("family.height") : title} below={0} room={room} expanded onLetGo={hideReaderPanel}
      store={panelExtent} first={0.45} unname={unnamePanel}
      className="inset-x-0 z-(--layer-dialog) border-t-hairline border-lit-line bg-raised text-ink shadow-float">
      {body("sheet")}
    </PhoneSheet>, place);
  if (beside) return createPortal(
    <section ref={keep} role="dialog" aria-modal={false} aria-label={title} data-reader-panel={kind}
      data-reader-panel-surface="beside" data-family-surface={kind === "family" ? "beside" : undefined}
      style={{ left: beside.left, top: beside.top, width: beside.width, maxHeight: beside.height }}
      className="fixed z-(--layer-card) flex animate-fade flex-col overflow-hidden rounded-pane border-hairline border-lit-line bg-raised text-ink shadow-float">
      {body("beside")}
    </section>, place);
  if (!under) return null;
  return createPortal(
    <section ref={keep} role="dialog" aria-modal={false} aria-label={title} data-reader-panel={kind}
      data-reader-panel-surface="under" data-family-surface={kind === "family" ? "under" : undefined}
      style={{ marginTop: OPEN_GAP }} className="mb-1 animate-fade overflow-hidden rounded-lg border-hairline border-lit-line bg-raised text-ink">
      {body("under")}
    </section>, under);
}

/** A closing sheet's animated copy is a picture, without live rows or controls. */
function unnamePanel(copy: HTMLElement) {
  for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("*")])
    for (const name of element.getAttributeNames())
      if (name.startsWith("data-family") || name.startsWith("data-reader-panel") || name.startsWith("data-order") || name === "role" || name.startsWith("aria-"))
        element.removeAttribute(name);
}
