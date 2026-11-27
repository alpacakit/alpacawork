import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commandRoute } from "@alpacawork/contract/command-path";
import { automationDestinationListSchema } from "@alpacawork/contract/automation-program";
import { Button } from "@/components/ui/button";
import { errorText } from "@/data/client";
import { api } from "@/data/resources";
import { workspaceWriteBasis } from "@/data/connection";
import { useWorkspaceInfo, useWriteDisabled } from "@/data/queries";
import type { Automation } from "./shape";

/**
 * Where an automation may send, as its project keeps them: each by its name, its host once entered, and the
 * automations using it. Entering or entering again is a person's act here (the coordinator can enter one given in a
 * conversation too): the address is sent once and never read back, so only its host shows.
 */
export function useDestinations(project: string) {
  const root = useWorkspaceInfo(info => info.root), version = useWorkspaceInfo(info => info.automationsVersion);
  return useQuery({ queryKey: ["automation-destinations", root, project, version], enabled: !!root, staleTime: Infinity,
    queryFn: ({ signal }) => api.request(`${commandRoute("automation/destination-list")}?under=${encodeURIComponent(project)}`, automationDestinationListSchema, signal)
      .then(answer => answer.destinations) });
}

function useSetDestination(project: string) {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  return useMutation({ meta: { errorToast: false }, mutationFn: ({ name, url, header }: { name: string; url: string; header: string }) =>
    api.request(commandRoute("automation/destination-set"), automationDestinationListSchema, undefined,
      { under: project, name, url, ...header ? { header } : {} }, crypto.randomUUID(), workspaceWriteBasis()),
    onSuccess: () => { for (const key of ["automation-destinations", "automations", "automation"]) void client.invalidateQueries({ queryKey: [key, root] }); } });
}

/** Each destination the automation names: its host or that it is missing, the others using it, and entering it. */
export function DestinationRows({ automation, names }: { automation: Pick<Automation, "id" | "project">; names: readonly { name: string; host: string | null; ready: boolean }[] }) {
  const { t } = useTranslation("automations");
  const listed = useDestinations(automation.project).data;
  return <div data-automation-destinations className="flex flex-col gap-1.5">
    {names.map(each => {
      const kept = listed?.find(item => item.name === each.name);
      const others = (kept?.usedBy ?? []).filter(user => user.id !== automation.id);
      return <Destination key={each.name} project={automation.project} name={each.name} host={kept?.host ?? each.host} ready={kept?.ready ?? each.ready}
        others={others.map(user => `${user.id} ${user.name}`)} />;
    })}
    {!names.length && <p className="m-0 text-muted">{t("outside.none")}</p>}
    <p className="m-0 text-xs text-muted">{t("destination.viaCoordinator")}</p>
  </div>;
}

function Destination({ project, name, host, ready, others }: { project: string; name: string; host: string | null; ready: boolean; others: string[] }) {
  const { t } = useTranslation("automations");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(""), [header, setHeader] = useState("");
  const save = useSetDestination(project);
  const writeDisabled = useWriteDisabled();
  return <div data-automation-destination={name} className="text-sm">
    <p className="m-0 flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono text-xs">{name}</span>
      {ready && host ? <span>{t("destination.hidden", { host })}</span> : <span className="text-error">{t("destination.missing")}</span>}
      {!editing && <Button variant="ref" data-automation-destination-edit disabled={writeDisabled} className="narrow:min-h-11" onClick={() => setEditing(true)}>
        {t(ready ? "destination.reenter" : "destination.enter")}</Button>}
    </p>
    {others.length > 0 && <p className="m-0 text-xs text-muted">{t("destination.usedBy", { list: others.join(t("listJoin")) })}</p>}
    {editing && <form className="mt-1.5 flex flex-col gap-1.5" onSubmit={event => {
      event.preventDefault();
      save.mutate({ name, url, header }, { onSuccess: () => { setEditing(false); setUrl(""); setHeader(""); } });
    }}>
      {/* Pasted, the address is not shown again: it holds a secret more often than not. */}
      <input type="password" data-automation-destination-url autoComplete="off" required value={url} onChange={change => setUrl(change.target.value)}
        aria-label={t("destination.url", { name })} placeholder={t("destination.urlPlaceholder")}
        className="min-h-9 w-full rounded-md border border-line bg-bg px-2 font-mono text-xs narrow:min-h-11" />
      <input type="password" data-automation-destination-header autoComplete="off" value={header} onChange={change => setHeader(change.target.value)}
        aria-label={t("destination.header")} placeholder={t("destination.headerPlaceholder")}
        className="min-h-9 w-full rounded-md border border-line bg-bg px-2 font-mono text-xs narrow:min-h-11" />
      <p className="m-0 text-xs text-muted">{t("destination.note")}</p>
      {save.error && <p className="m-0 text-xs text-error">{errorText(save.error)}</p>}
      <span className="flex gap-2">
        <Button type="submit" data-automation-destination-save disabled={!url || save.isPending} className="narrow:min-h-11">{t("destination.save")}</Button>
        <Button type="button" variant="outline" className="narrow:min-h-11" onClick={() => { setEditing(false); setUrl(""); setHeader(""); save.reset(); }}>{t("destination.cancel")}</Button>
      </span>
    </form>}
  </div>;
}
