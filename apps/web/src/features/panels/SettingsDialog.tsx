import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCoarsePointer } from "@/lib/input-capabilities";
import { FieldHint } from "@/components/ui/field";
import { useDialogStore, type SettingsFocus, type SettingsTab } from "@/state/dialog-store";
import { HostTab } from "./HostTab";
import { DialogBody } from "@/components/ui/dialog";
import { PanelDialog } from "./PanelDialog";
import { PersonalSettingsTab } from "./PersonalSettingsTab";
import { ServerSettingsTab } from "./ServerSettingsTab";
import { AppGuideTab } from "./AppGuideTab";
import { ProjectsSettingsTab } from "./ProjectsSettingsTab";
import { UpdateConfirmDialog, UpdateStateLine, VersionLine } from "@/features/update/UpdateView";

/**
 * Settings share one set of values per workspace: Personal saves each value at once; Server is one
 * draft of this PC's config.yaml, read with its hash when the dialog opens and saved with the buttons at its end, the
 * folder the server reads noted at its foot; App & phone guides installing the app and opening it from a phone; Host status is read-only; Projects lists every project, archived ones marked, each
 * opening its own settings, which are the project dialog's, not here. Updates have no tab: their one status line (with
 * its one action) above the tabs and the running version at the foot.
 */
export function SettingsDialog({ initialTab = "personal", request, focus }: { initialTab?: SettingsTab; request?: number; focus?: SettingsFocus } = {}) {
  const { t } = useTranslation("panels");
  return (
    <PanelDialog title={t("settings.title")} size="large" ownBody>
      <SettingsBody initialTab={initialTab} request={request} focus={focus} />
      <UpdateConfirmDialog />
    </PanelDialog>
  );
}

const TABS = ["personal", "server", "apps", "host", "projects"] as const satisfies readonly SettingsTab[];

export function SettingsBody({ initialTab = "personal", request, focus }: { initialTab?: SettingsTab; request?: number; focus?: SettingsFocus }) {
  const focusNotifications = focus === "notifications";
  const { t } = useTranslation("panels");
  const coarsePointer = useCoarsePointer();
  // The guide is read at a computer: a phone that opens this is past every step of it.
  const availableTabs = TABS.filter((value) => value !== "apps" || !coarsePointer);
  const [selected, setTab] = useState<SettingsTab>(initialTab);
  // A later request for a tab (a host push tapped while the dialog is open) moves there; drafts in the other tabs stay.
  const [seen, setSeen] = useState(request);
  const requested = request !== seen ? initialTab : selected;
  // A remembered tab, a later request and an input change all follow the same available-tab rule.
  const tab = availableTabs.includes(requested) ? requested : availableTabs[0]!;
  if (request !== seen || selected !== tab) {
    setSeen(request);
    setTab(tab);
  }
  // The gear reopens the usual tab this one was last on.
  useEffect(() => useDialogStore.getState().rememberSettingsTab(tab), [tab]);
  const list = useRef<HTMLDivElement>(null);
  // Each tab is read from its top: the place scrolled to in one tab means nothing in the next.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]);
  useEffect(() => {
    if (focusNotifications) document.getElementById("settings-notifications")?.focus();
  }, [focusNotifications]);
  // On narrow screens the row scrolls sideways and keeps the chosen tab in view.
  // Only the row scrolls, so the dialog keeps the place Notifications was focused at.
  useEffect(() => {
    const row = list.current, active = row?.querySelector('[data-state="active"]');
    if (!row || !active) return;
    const bounds = row.getBoundingClientRect(), chosen = active.getBoundingClientRect();
    if (chosen.left < bounds.left) row.scrollLeft -= bounds.left - chosen.left;
    else if (chosen.right > bounds.right) row.scrollLeft += chosen.right - bounds.right;
  }, [tab]);
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="min-h-0 flex-1">
      {/* The tabs stay with the head; only the tab shown scrolls under them. */}
      <div className="flex-none px-6 narrow:px-4.5">
        <UpdateStateLine />
        {/* The rule under the tabs is as wide as the rows below; the row itself reaches a little past both ends, so
            the first tab's face starts on the title's edge and its focus ring is drawn whole. */}
        <div className="border-b border-line">
          <TabsList ref={list} className="-mx-1 border-b-0">
            {/* Mapped over TABS itself: i18n:extract reads each `settings.tabs.*` key from this constant list, not a filtered copy. */}
            {TABS.map((value) => availableTabs.includes(value) && <TabsTrigger key={value} value={value}>
              {t(`settings.tabs.${value}`)}
            </TabsTrigger>)}
          </TabsList>
        </div>
      </div>
      <DialogBody ref={body} className="flex flex-col border-t-0 pt-5">
      <TabsContent value="personal">
        <FieldHint className="mb-6">{t("settings.scope.personal")}</FieldHint>
        <PersonalSettingsTab focusNotifications={focusNotifications} />
      </TabsContent>
      {/* Mounted while hidden so the draft survives switching tabs. */}
      <TabsContent value="server" forceMount hidden={tab !== "server"}>
        <ServerSettingsTab focusCoordinatorAi={focus === "coordinatorAi" ? request ?? 0 : undefined} />
      </TabsContent>
      <TabsContent value="host">
        <HostTab />
      </TabsContent>
      {availableTabs.includes("apps") && <TabsContent value="apps">
        <AppGuideTab />
      </TabsContent>}
      <TabsContent value="projects">
        <ProjectsSettingsTab />
      </TabsContent>
      {/* At the foot of the box when the tab shown is short, after its last line when it is long. */}
      <div className="mt-auto"><VersionLine /></div>
      </DialogBody>
    </Tabs>
  );
}
