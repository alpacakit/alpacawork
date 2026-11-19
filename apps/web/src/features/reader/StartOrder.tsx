import { useEffect, useRef, useState } from "react";
import { PanelFirstRow } from "./PanelFirstRow";
import { panelPosition } from "./reader-panel";
import type { PanelForm } from "./ReaderPanel";
import { useTranslation } from "react-i18next";
import { TaskIcon, TaskLabel } from "@/components/ui/state-label";
import { TaskId } from "@/components/ui/task-id";
import { useEveryTaskIndex } from "@/data/queries";
import type { Task } from "@/data/types";
import { byOrderAttention, startOrderOf, waitersOf, type OrderItem, type WaiterItem } from "@/domain/start-order";
import { cn } from "@/lib/utils";

/** The list's and the tree's word in place of "Queued" while a task waits for others; null when it does not. */
export function useOrderWord(task: Task): { shown: string; items: OrderItem[] } | null {
  const { t } = useTranslation("reader");
  const index = useEveryTaskIndex();
  const order = startOrderOf(task, index);
  if (!order?.waitingFor.length) return null;
  const items = order.waitingFor, first = items[0]!;
  const shown = items.length <= 2 ? t("order.list.wait", { ids: items.map(each => each.id).join(t("order.separator")) })
    : t("order.list.waitMore", { id: first.id, count: items.length - 1 });
  return { shown, items };
}

/** The list's word on a row others wait for: which tasks wait for it to finish; null when none. */
export function useWaitedWord(task: Task): { shown: string; items: WaiterItem[] } | null {
  const { t } = useTranslation("reader");
  const index = useEveryTaskIndex();
  const items = waitersOf(task.id, index).map(asWaiterItem);
  if (!items.length) return null;
  return { shown: items.length === 1 ? t("order.list.waited", { id: items[0]!.id })
    : t("order.list.waitedMore", { id: items[0]!.id, count: items.length - 1 }), items };
}

const asWaiterItem = (task: Task): WaiterItem => ({ kind: "waiter", id: task.id, title: task.title, state: task.state, ball: task.ball, rowFacts: task.rowFacts });

/** In the related list, a task is a row as the tree's are: a band with round ends, tinted under a pointer, reaching
 * 6px from the surface's sides as the tree's rows do; the list's head and notes keep 12px, clear of its round corners. */
const ORDER_ROW = "-mx-1.5 min-h-7.5 w-[calc(100%+--spacing(3))] max-w-none rounded-full px-3 hover:bg-hover hover:no-underline narrow:min-h-10";

/** One task, as a press that opens it: its state icon, ID and title, then its state in words. */
export function OrderLink({ item, onFollow, word = true, className }: { item: OrderItem | WaiterItem; onFollow: (id: string) => void; word?: boolean; className?: string }) {
  const { t } = useTranslation("reader");
  const prerequisite = item.kind === "prerequisite" ? item : null;
  return <button type="button" data-order-task={item.id} onClick={() => onFollow(item.id)}
    className={cn("flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-left hover:underline", className)}>
    <TaskIcon task={item} className="size-3.5 flex-none" />
    <TaskId id={item.id} className="flex-none text-xs tabular-nums text-muted" />
    <span className="min-w-0 truncate text-ink">{item.title}</span>
    {word && <TaskLabel task={item} className="ms-1" />}
    {/* Done or stopped, but a Run of it has not ended: it still waits for that. */}
    {word && prerequisite && !prerequisite.finished && (item.state === "done" || item.state === "stopped")
      && <span className="ms-1 flex-none text-xs text-ink">{t("order.runEnding")}</span>}
  </button>;
}

/** The list tip's body: each task named, the one to look at first on top. */
export function OrderTipBody({ items, onFollow }: { items: (OrderItem | WaiterItem)[]; onFollow: (id: string) => void }) {
  return <div data-order-tip className="mt-1 grid gap-1.5">
    {items.map(each => <OrderLink key={each.id} item={each} onFollow={onFollow} />)}
  </div>;
}

/** Both directions share a scroll position and focus; the first section's heading takes the tree root's place. */
export function OrderList({ task, form, onFollow, onClose }: {
  task: Task; form: PanelForm; onFollow: (id: string) => void; onClose: () => void;
}) {
  const { t } = useTranslation("reader");
  const index = useEveryTaskIndex();
  const order = startOrderOf(task, index);
  const after = order?.after.slice().sort(byOrderAttention) ?? [];
  const waiters = waitersOf(task.id, index).map(asWaiterItem);
  const list = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const position = panelPosition("dependencies", task.id);
  useEffect(() => { if (list.current) setScrolled(list.current.scrollTop > 0); });
  useEffect(() => {
    let frame = 0, tries = 0;
    const place = () => {
      const box = list.current;
      if (!box) return;
      if ((!box.isConnected || box.clientHeight === 0 && tries < 30) && tries++ < 300) {
        frame = requestAnimationFrame(place); return;
      }
      box.scrollTop = position.scroll;
      box.querySelector<HTMLElement>("[data-order-task]")?.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [position]);
  return <div data-order-list="dependencies" className={cn("flex flex-col", form === "under" ? "" : "min-h-0 flex-1")}>
    {form === "sheet" && <div data-card-grab className="h-8 flex-none touch-none" />}
    <div ref={list} data-order-scroll onScroll={event => { setScrolled(event.currentTarget.scrollTop > 0); position.scroll = event.currentTarget.scrollTop; }}
      className={cn("isolate scroll-pt-9 overflow-auto overscroll-contain px-3 pb-1.5 text-sm narrow:text-base narrow:scroll-pt-12", form === "under" ? "max-h-54" : "min-h-0 flex-1",
        form === "sheet" && "pb-[max(0.5rem,env(safe-area-inset-bottom))]")}>
      <PanelFirstRow data-order-head scrolled={scrolled} closeLabel={t("readerHeader.closeShort")} onClose={onClose}>
        <h3 className="m-0 flex h-7.5 items-center px-1.5 text-xs font-medium text-muted narrow:h-10">{t(after.length ? "entries.after" : "entries.waiters")} {t("family.count", { count: after.length || waiters.length })}</h3>
      </PanelFirstRow>
      {after.length > 0 && <section data-order-section="after">
        {order?.started && <p data-order-started className="mt-0 mb-1 px-1.5 text-xs text-muted">{t("order.startedLead")}</p>}
        <ul aria-label={t("entries.after")} className="m-0 grid list-none gap-0.5 p-0">
          {after.map(each => <li key={each.id} className="min-w-0">
            <OrderLink item={each} onFollow={onFollow} className={ORDER_ROW} />
            {!order?.started && each.urge === "stuck" && <p data-order-stuck className="m-0 mb-1 px-1.5 text-sm text-ink">
              {t(each.state === "error" ? "order.stuck.error" : "order.stuck.held", { id: each.id })}</p>}
          </li>)}
        </ul>
      </section>}
      {waiters.length > 0 && <section data-order-section="waiters" className={after.length ? "mt-3" : undefined}>
        {after.length > 0 && <h3 className="m-0 flex h-7.5 items-center px-1.5 text-xs font-medium text-muted narrow:h-10">{t("entries.waiters")} {t("family.count", { count: waiters.length })}</h3>}
        <ul aria-label={t("entries.waiters")} className="m-0 grid list-none gap-0.5 p-0">
          {waiters.map(each => {
            const others = startOrderOf(index.byId.get(each.id)!, index)?.waitingFor.filter(item => item.id !== task.id) ?? [];
            return <li key={each.id} className="min-w-0">
              <OrderLink item={each} onFollow={onFollow} className={ORDER_ROW} />
              <p className="m-0 mb-1 px-1.5 text-xs text-muted">{others.length
                ? t("order.alsoWaits", { ids: others.map(item => item.id).join(t("order.separator")) }) : t("order.onlyThis")}</p>
            </li>;
          })}
        </ul>
      </section>}
    </div>
  </div>;
}

/** History's structured dependency IDs, said in the reader's words with the tasks' titles. */
export function orderRecordWords(change: { after: string[]; previous: string[] }, titleOf: (id: string) => string | undefined,
  t: (key: string, values?: Record<string, unknown>) => string): { text: string; description: string } {
  const { after, previous: before } = change;
  const named = (id: string) => {
    const title = titleOf(id);
    return title ? `${id} ${title}` : id;
  };
  const previous = before.length ? t("order.history.previous", { ids: before.join(t("order.separator")) }) : "";
  if (!after.length) return { text: t("order.history.cleared"), description: previous };
  return { text: t("order.history.set", { ids: after.join(t("order.separator")) }),
    description: [...after.map(id => `- ${named(id)}`), ...(previous ? ["", previous] : [])].join("\n") };
}
