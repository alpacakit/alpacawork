import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeading } from "@/components/ui/dialog";
import { Message } from "@/components/ui/message";
import { PendingRegion } from "@/components/ui/loadable";
import { errorText } from "@/data/client";
import { useWriteDisabled } from "@/data/queries";
import { formatLogTime } from "@/domain/time";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useViewStore } from "@/state/view-store";
import { eventTemplate, usePreview, usePreviewRun, useTry } from "./data";
import { Fact, Fields, IntentLine, askText, fieldsText } from "./RunParts";
import type { Automation, Preview, PreviewResult } from "./shape";
import { usd, whenText } from "./words";

/** The events offered to try it at, at most: the newest first, then writing one. */
const CANDIDATES_SHOWN = 5;

/**
 * Trying it, in two steps before anything happens. Choosing an event runs `trigger` alone and says whether it would
 * let it through and why. Only then can `run` be shown too, its writes replaced by what it would do ("see what it
 * would do": it may call an AI, which costs, so only on a press), with what any AI answered. "Do it for real" (a
 * person only) runs it at the event shown, as a trial outside its limits. What the program does by itself (files, the
 * network) is not replaced, and is said by the buttons.
 */
export function TryDialog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const { t, i18n } = useTranslation("automations");
  const [event, setEvent] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(() => eventTemplate(automation.latest.facts.when.event));
  const [sentWritten, setSentWritten] = useState<string | null>(null);
  // By the clock, the server shows its next time as soon as it is asked (`trigger` runs then): asked only on a press.
  const byClock = automation.latest.facts.when.event === "schedule" && !!automation.latest.docs.trigger;
  const [asked, setAsked] = useState(!byClock);
  const preview = usePreview(automation, writing ? null : event, writing ? sentWritten : null, asked || writing);
  const run = usePreviewRun();
  const go = useTry();
  const writeDisabled = useWriteDisabled();
  const setPane = useViewStore(state => state.setAutomationPane);
  const facts = automation.latest.facts;
  // The events offered stay while another showing is refused (a written event the server does not take).
  const seen = useRef<PreviewResult["candidates"]>([]);
  if (preview.data) seen.current = preview.data.candidates;
  const candidates = seen.current.slice(0, CANDIDATES_SHOWN);
  // Opening it runs nothing: `trigger` runs once an event is chosen (it may ask an AI, which costs).
  const triggerAsks = !!automation.latest.docs.trigger && facts.ai.some(row => row.use !== "task");

  // What was shown, only once it is the answer for what is chosen now: while another event's answer is still on its
  // way, the last one's is no answer for it, and nothing can be done from it.
  // Writing what arrives, nothing is shown until it is sent: the newest event's answer is no answer for it.
  const unsent = writing && sentWritten === null;
  const first = preview.isPlaceholderData || unsent ? null : preview.data?.preview ?? null;
  const shown: Preview | null = run.data && first && run.variables?.preview.hash === first.hash ? run.data : first;
  // `trigger` failed: no answer to go on from.
  const failedTrigger = !!shown && !shown.trigger && !!automation.latest.docs.trigger && shown.outcome?.state === "failed";
  const chosen = writing ? null : event ?? preview.data?.preview?.event.ref ?? null;
  const asks = facts.ai.some(row => row.use === "ask");
  const cost = facts.ai.find(row => row.use === "ask")?.costHint?.perCallUsd;
  const doIt = () => shown && go.mutate({ automation: automation.id, preview: shown }, { onSuccess: () => {
    onClose();
    setPane("log");
    notify.success(t("try.done", { id: automation.id }));
  } });
  const pick = (ref: string | null) => { run.reset(); setWriting(ref === null); if (ref) setEvent(ref); };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-automation-try-dialog>
      <DialogHeading title={t("try.title", { id: automation.id })} description={<>{t("try.which", { when: whenText(t, facts.when, facts.limits.timezone) })}
        {/* Its newest version is what is tried: said while another one runs. */}
        {automation.awaitingEnable && <span data-automation-try-version className="block">{t("try.newVersion")}</span>}</>} />
      <DialogBody>
        {triggerAsks && <p data-automation-try-cost className="m-0 mb-2 text-sm text-muted">{facts.ai.some(row => row.use === "ask")
          ? cost !== undefined ? t("try.triggerCost", { usd: usd(cost) }) : t("try.triggerAi") : t("try.triggerMayAi")}</p>}
        {!asked && !writing && <Button variant="outline" data-automation-try-next className="mb-2 narrow:min-h-11" onClick={() => setAsked(true)}>{t("try.next")}</Button>}
        <div role="radiogroup" aria-label={t("try.events")} className="flex flex-col gap-0.5">
          {preview.isPending && !preview.data ? <PendingRegion pending shape="rows" />
            : !candidates.length && <p className="m-0 py-1 text-sm text-muted">{t("try.noEvent")}</p>}
          {candidates.map(each => <label key={each.ref} data-automation-try-event={each.ref}
            className={cn("flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-row-hover has-checked:bg-hover narrow:min-h-11")}>
            <input type="radio" name="event" className="mt-1 accent-ink" checked={chosen === each.ref} onChange={() => pick(each.ref)} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3"><span dir="auto" className="min-w-0 truncate">{each.title ?? formatLogTime(each.at, i18n.language)}</span>
                <span className="flex-none text-xs text-muted tabular-nums">{formatLogTime(each.at, i18n.language)}</span></span>
              {!!each.fields?.length && <span className="block truncate text-xs text-muted">{fieldsText(t, each.kind, each.fields)}</span>}
            </span>
          </label>)}
          <label data-automation-try-write className="flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-row-hover has-checked:bg-hover narrow:min-h-11">
            <input type="radio" name="event" className="mt-1 accent-ink" checked={writing} onChange={() => pick(null)} />
            <span>{t("try.write")}</span>
          </label>
          {writing && <div className="ms-8 flex flex-col gap-1.5">
            <textarea data-automation-try-json aria-label={t("try.writeLabel")} value={written} onChange={change => setWritten(change.target.value)} rows={5}
              className="w-full rounded-md border border-line bg-bg p-2 font-mono text-xs" />
            <Button variant="outline" className="self-start narrow:min-h-11" onClick={() => { run.reset(); setSentWritten(written); }}>{t("try.writeShow")}</Button>
          </div>}
        </div>
        {preview.error && <Message tone="caution" size="line" className="mt-3" title={errorText(preview.error)} />}
        {preview.isPlaceholderData && <PendingRegion pending shape="rows" />}
        {shown && <dl data-automation-try-result className="m-0 mt-3 grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-rule pt-3 text-sm narrow:grid-cols-1 narrow:gap-y-0.5">
          {!!shown.event.fields?.length && writing && <Fact name={t("runs.arrived")}><Fields fields={shown.event.fields} kind={shown.event.kind} /></Fact>}
          <Fact name={t("try.passes")}>{failedTrigger ? <span className="text-error">{t("try.triggerFailed", { message: shown.outcome?.error?.message ?? "" })}</span> : shown.trigger ? <>{t(shown.trigger.run ? "try.pass" : "try.reject", { reason: shown.trigger.reason })}
            {shown.durationMs != null && <span className="text-muted">{t("join")}{t("runs.seconds", { seconds: (shown.durationMs / 1000).toFixed(1) })}</span>}</>
            : automation.latest.docs.trigger ? null : t("try.noTrigger")}</Fact>
          {shown.ran && shown.operations.filter(operation => operation.name === "ai.ask").map((operation, at) =>
            <Fact key={at} name={t("runs.judged")}>{askText(t, operation)}</Fact>)}
          {!failedTrigger && (!shown.trigger || shown.trigger.run) && <Fact name={t("try.intent")}>
            {shown.ran ? <IntentResult preview={shown} automation={automation} />
              : <div className="flex flex-col items-start gap-1">
                <Button variant="outline" data-automation-try-run className="narrow:min-h-11" disabled={writeDisabled || run.isPending}
                  onClick={() => run.mutate({ automation, preview: shown, written: writing ? sentWritten : null })}>{t("try.showIntent")}</Button>
                <span className="text-xs text-muted">{asks ? cost !== undefined ? t("try.intentCost", { usd: usd(cost) }) : t("try.intentAi") : facts.ai.length ? t("try.intentMayAi") : t("try.intentNoAi")}</span>
                {run.error && <span className="text-sm text-error">{errorText(run.error)}</span>}
              </div>}
          </Fact>}
        </dl>}
        <p className="m-0 mt-3 border-t border-rule pt-3 text-xs text-muted">{t("try.note")}</p>
        {go.error && <Message tone="caution" size="line" className="mt-2" title={errorText(go.error)} />}
        <DialogFooter>
          <Button variant="outline" className="narrow:min-h-11" onClick={onClose}>{t("try.cancel")}</Button>
          <Button data-automation-try-do className="narrow:min-h-11" disabled={writeDisabled || go.isPending || !shown || failedTrigger || shown.trigger?.run === false || shown.ran && shown.outcome?.state === "failed"} onClick={doIt}>{t("try.do")}</Button>
        </DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/** What it would do, once `run` was shown: each write it would make, or what it came to (skipped, failed, why). */
function IntentResult({ preview, automation }: { preview: Preview; automation: Automation }) {
  const { t } = useTranslation("automations");
  const intents = preview.operations.filter(operation => operation.replaced);
  const outcome = preview.outcome;
  if (outcome?.state === "failed") return <span className="text-error">{outcome.error?.message ?? outcome.summary ?? t("try.failed")}</span>;
  return <>
    {intents.length ? intents.map((operation, at) => <IntentLine key={at} operation={operation} automation={automation} />) : <p className="m-0">{t("band.intentNothing")}</p>}
    {outcome?.summary && <p className="m-0 text-xs text-muted">{t("try.summary", { text: outcome.summary })}</p>}
  </>;
}
