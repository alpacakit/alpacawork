import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FieldHint } from "@/components/ui/field";
import { Message } from "@/components/ui/message";
import { Label } from "@/components/ui/label";
import { SETTING_ROW } from "@/components/settings/SettingRow";
import { cn } from "@/lib/utils";
import { receivingPush, pushSupported, usePushDevices, usePushHere, useSubscribePush, useUnsubscribePush } from "@/data/push";
import { formatNoticeTime } from "@/domain/time";

/**
 * The notification tab in global settings: whether this browser receives Web Push, the button to
 * start or stop, and every registered device with its remove button (a lost
 * device is removed here, since delivery does not go through the tailnet). Whether this browser receives them is
 * receivingPush, as the guide reads it too.
 */
export function PushSection({ focusHeading = false }: { focusHeading?: boolean }) {
  const { t, i18n } = useTranslation("panels");
  const supported = pushSupported();
  const here = usePushHere();
  const devices = usePushDevices(supported);
  const state = receivingPush(supported, here.data, devices.data?.devices);
  const own = here.data?.subscription ?? null;
  const subscribe = useSubscribePush();
  const unsubscribe = useUnsubscribePush();
  const busy = subscribe.isPending || unsubscribe.isPending;
  const start = () => subscribe.mutate();
  const ownOf = (device: { endpoint: string }) => own && device.endpoint === own.endpoint ? own : null;
  const ownDevice = state === "on" ? devices.data?.devices.find(ownOf) : undefined;
  /** Removing this browser's own device ends its subscription too. */
  const removeDevice = (device: { id: string; endpoint: string }) => unsubscribe.mutate({ id: device.id, own: ownOf(device) });
  return (
    <section aria-labelledby="push-title" className="text-base">
      {/* A row of the list it ends: its name and what it says on the left, its one button on the right. */}
      <div className={cn(SETTING_ROW, "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 narrow:gap-x-4")}>
        <Label asChild><h3 id="push-title" tabIndex={focusHeading ? -1 : undefined} className="m-0 font-normal outline-none">{t("push.title")}</h3></Label>
        {(state === "on" || state === "off") && (ownDevice
          ? <Button variant="outline" disabled={busy} onClick={() => removeDevice(ownDevice)} className="row-span-2 narrow:row-span-1">{t("push.unsubscribe")}</Button>
          : <Button disabled={busy} onClick={start} className="row-span-2 narrow:row-span-1">{t("push.subscribe")}</Button>)}
        <FieldHint className="col-start-1 narrow:col-span-2">
          {state === "unsupported" ? t("push.unsupported") : state === "blocked" ? t("push.denied") : state === "on" ? t("push.subscribed") : t("push.hint", { events: t("settings.personal.pushEvents") })}
        </FieldHint>
      </div>
      {supported && devices.data && (
        <div className={cn(SETTING_ROW, "pb-0")}>
          <h4 className="m-0 font-normal">{t("push.devices")}</h4>
          {devices.data.devices.length ? (
            <ul className="m-0 mt-1 flex list-none flex-col p-0">
              {devices.data.devices.map((device) => (
                <li key={device.id} className="flex min-h-control-md items-center justify-between gap-2 text-sm narrow:min-h-11">
                  <span className="min-w-0 text-muted">
                    <span className="text-ink">{device.label}</span>
                    {ownOf(device) ? <span> · {t("push.thisDevice")}</span> : null}
                    <span> · {formatNoticeTime(device.created_at, i18n.language)}</span>
                  </span>
                  <Button variant="quiet" disabled={busy} onClick={() => removeDevice(device)}>
                    {t("push.remove")}
                  </Button>
                </li>
              ))}
            </ul>
          ) : <Message tone="empty" size="line" className="mt-1" title={t("push.noDevices")} />}
        </div>
      )}
    </section>
  );
}
