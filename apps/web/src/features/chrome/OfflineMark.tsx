import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popup } from "@/components/ui/popup";
import { useConnection } from "@/data/connection";
import { browserOnline, subscribeOnline } from "@/data/reach";
import { formatNoticeTime } from "@/domain/time";

/**
 * Out of reach: the screen's one mark, in the bar before the person's own buttons, drawn whether or not
 * anything has been read yet. The list, the reader and the conversation say nothing of their own. It is the bar's icon
 * button in ink, not the failure colour: nothing failed that a person did. Pressed, the app's one Popup, headed by the
 * mark and its title, says in one short paragraph since when what is shown was received and that nothing can be sent
 * until it is back, and, where there is something to reach, offers to reconnect at once (retries go on by themselves
 * either way). It closes as every popup does; back in reach, the mark goes and the popup with it.
 * The time is the feed's last arrival, the newest any of the screen was; none is told before anything arrived.
 */
export function OfflineMark() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const at = useConnection((state) => state.lastReceivedAt ?? null);
  // A browser that says it is offline has nothing to reconnect to.
  const online = useSyncExternalStore(subscribeOnline, browserOnline);
  const clock = at ? formatNoticeTime(new Date(at).toISOString(), i18n.language) : "";
  const label = clock ? `${t("offline.mark")} · ${t("offline.acquired", { time: clock })}` : t("offline.mark");
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <Button ref={trigger} variant="ghost" size="bar" data-offline-mark aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
      className="narrow:w-9" onClick={() => setOpen((was) => !was)}><Icon name="offline" /></Button>
    {open && <Popup open onOpenChange={setOpen} label={t("offline.title")} className="w-80" anchorRef={trigger}
      heading={<span className="flex items-center gap-2"><Icon name="offline" className="flex-none" />{t("offline.title")}</span>}>
      <div data-offline-explanation className="grid gap-4 text-sm">
        <p className="m-0 text-muted">{clock ? t("offline.shown", { time: clock }) : t("offline.meanwhile")}</p>
        {online && <Button data-offline-reconnect className="w-full min-h-control-md narrow:min-h-11"
          onClick={() => { setOpen(false); useConnection.getState().reconnect(); }}>{t("chrome:notice.reconnect")}</Button>}
      </div>
    </Popup>}
  </>;
}
