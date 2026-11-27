import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PendingRegion, ReadFailure } from "@/components/ui/loadable";
import { useRunInput } from "./data";

/** What was handed over, as it came: the sender's material for the task's AI to read, not an instruction. */
export function RunInput({ task }: { task: string }) {
  const { t } = useTranslation("automations");
  const input = useRunInput(task);
  return <div data-automation-input className="basis-full">
    {input.error ? <ReadFailure what={t("runs.input.failed")} error={input.error} retry={() => input.refetch()} />
      : input.isPending ? <PendingRegion pending shape="rows" />
      : input.data === null ? <p className="m-0 mt-1 text-muted">{t("runs.input.none")}</p>
      : <>
        <p className="m-0 mt-1 text-muted">{t("runs.input.note")}</p>
        <pre dir="auto" className="m-0 mt-1 max-h-80 overflow-auto rounded-md bg-hover p-3 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(input.data, null, 2)}</pre>
      </>}
  </div>;
}

/**
 * Where a task's instruction says what a signal or the PC's pressure handed over (`splitAutomationInputNote`): in the
 * person's words, with what came opened on a press. The AI reads the same through a command.
 */
export function HandedInput({ task }: { task: string }) {
  const { t } = useTranslation("automations");
  const [reading, setReading] = useState(false);
  return <div data-handed-input className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
    <span>{t("runs.input.handed")}</span>
    <Button variant="ref" aria-expanded={reading} onClick={() => setReading(!reading)}>{t(reading ? "runs.input.hide" : "runs.input.show")}</Button>
    {reading && <RunInput task={task} />}
  </div>;
}
