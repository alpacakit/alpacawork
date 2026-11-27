import { automationEventSource } from "@alpacawork/contract/automation-program";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { Automation } from "./shape";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeading } from "@/components/ui/dialog";
import { Message } from "@/components/ui/message";
import { ReadFailure } from "@/components/ui/loadable";
import { useWriteDisabled } from "@/data/queries";
import { errorText } from "@/data/client";
import { formatLogTime } from "@/domain/time";
import { textClip } from "@/lib/clipboard";
import { useAutomationAct, useHookUrl } from "./data";
import { hookCall, signalCommand } from "./words";

/**
 * How a signal is sent: the one line a sender on this PC runs, or, for one with a receiving point, its URL and a call
 * to it. Which of the two follows the stored fact that it has a receiving point; one without offers to make one.
 */
export function Sender({ automation }: { automation: Automation }) {
  return <div data-automation-sender className="flex flex-col gap-1 text-sm">
    {automation.hook.exists ? <HookWay automation={automation} /> : <CliWay automation={automation} />}
  </div>;
}

/** A line to copy, as a command is shown on this screen. */
function CopyLine({ text, label, data }: { text: string; label: string; data: string }) {
  return <div className="flex items-center gap-1">
    <code {...{ [data]: "" }} className="min-w-0 flex-1 rounded-md bg-hover px-2 py-1 text-xs [overflow-wrap:anywhere]">{text}</code>
    <CopyButton clip={() => textClip(text)} label={label} />
  </div>;
}

/** No receiving point: the line a sender on this PC runs, and the way to make a receiving point for other tools. */
function CliWay({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  const act = useAutomationAct();
  const writeDisabled = useWriteDisabled();
  const make = <Button variant="ref" data-automation-hook-create disabled={writeDisabled || act.isPending}
    onClick={() => act.mutate({ act: "hook-create", automation })} />;
  return <>
    <p className="m-0 mt-1 text-muted">{t("signal.howToSend")}</p>
    <CopyLine text={signalCommand(automation.id)} label={t("signal.copy")} data="data-automation-signal-command" />
    <p className="m-0 text-xs text-muted">{t("signal.commandNote")}</p>
    <p data-automation-hook-offer className="m-0 mt-1 text-xs text-muted"><Trans t={t} i18nKey="hook.offer" components={{ make }} /></p>
  </>;
}

/**
 * A receiving point: its URL (hidden until asked for, copied whole), what a leaked URL means and where calls can come
 * from, making it anew, an example call, and that the CLI still sends on this PC.
 */
function HookWay({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  const url = useHookUrl(automation);
  const [shown, setShown] = useState(false);
  const [remaking, setRemaking] = useState(false);
  const [remade, setRemade] = useState(false);
  const writeDisabled = useWriteDisabled();
  const call = hookCall(automation.id);
  // The secret is the URL's last part: hidden, the rest still says where it goes.
  const hidden = url.data?.replace(/[^/]+$/, "••••••••••••");
  return <>
    <p className="m-0 mt-1 text-muted">{t("hook.url")}</p>
    {url.error ? <ReadFailure what={t("hook.urlFailed")} error={url.error} retry={() => url.refetch()} />
      : <div className="flex items-center gap-1">
        <code data-automation-hook-url className="min-w-0 flex-1 rounded-md bg-hover px-2 py-1 text-xs [overflow-wrap:anywhere]">
          {!url.data ? "…" : shown ? url.data : hidden}</code>
        <Button variant="outline" data-automation-hook-show disabled={!url.data} aria-pressed={shown} onClick={() => setShown(!shown)}>{t(shown ? "hook.hide" : "hook.show")}</Button>
        {url.data && <CopyButton clip={() => textClip(url.data!)} label={t("hook.copy")} />}
      </div>}
    <p className="m-0 text-xs text-muted">{t("hook.secret")}{" "}
      {!remade && <Button variant="ref" data-automation-hook-rotate disabled={writeDisabled} onClick={() => setRemaking(true)}>{t("hook.remake")}</Button>}</p>
    {remade && <Message data-automation-hook-remade tone="info" size="line" title={t("hook.remade")} />}
    <p className="m-0 mt-1 text-muted">{t("hook.example")}</p>
    <CopyLine text={call} label={t("hook.exampleCopy")} data="data-automation-hook-call" />
    <p className="m-0 text-xs text-muted">{t("hook.keyNote")} {t("hook.cli", { command: `alpacawork automation signal --automation ${automation.id}` })}</p>
    {remaking && <RemakeDialog automation={automation} onClose={() => setRemaking(false)} onRemade={() => { setRemaking(false); setRemade(true); setShown(false); }} />}
  </>;
}

/**
 * Making the URL anew, asked first: the URL in use stops at once, so the caller has to take the new one before the
 * automation runs from it again.
 */
function RemakeDialog({ automation, onClose, onRemade }: { automation: Automation; onClose: () => void; onRemade: () => void }) {
  const { t, i18n } = useTranslation("automations");
  const act = useAutomationAct({ errorToast: false });
  const last = automation.lastRun && automationEventSource(automation.lastRun.event.kind) === "signal" && !automation.lastRun.event.manual ? automation.lastRun.at : null;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-automation-hook-rotate-dialog>
      <DialogHeading title={t("hook.remakeTitle")} />
      <DialogBody>
        <p className="m-0">{t("hook.remakeBody")}</p>
        <p className="m-0 mt-2 text-sm text-muted">{last ? t("hook.remakeCallerAt", { time: formatLogTime(last, i18n.language), name: automation.name })
          : t("hook.remakeCaller", { name: automation.name })}</p>
        {act.error && <Message tone="caution" size="line" className="mt-3" title={errorText(act.error)} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("hook.remakeCancel")}</Button>
          <Button data-automation-hook-rotate-do disabled={act.isPending} onClick={() => act.mutate({ act: "hook-rotate", automation }, { onSuccess: onRemade })}>{t("hook.remakeDo")}</Button>
        </DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
