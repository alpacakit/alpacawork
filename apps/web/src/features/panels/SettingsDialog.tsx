import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCoarsePointer } from "@/lib/input-capabilities";
import { FieldHint } from "@/components/ui/field";
import { useDialogStore, type SettingsFocus, type SettingsTab } from "@/state/dialog-store";
import { HostTab } from "./HostTab";
import { DialogBody, DialogCloseButton, DialogTitle } from "@/components/ui/dialog";
import { PanelDialog } from "./PanelDialog";
import { GeneralSettingsTab, NotificationSettingsTab } from "./PersonalSettingsTab";
import { AdvancedServerOptions, AiSettingsTab, ServerDraftProvider, ServerFolderLines } from "./ServerSettingsTab";
import { AppGuideTab } from "./AppGuideTab";
import { ProjectsSettingsTab } from "./ProjectsSettingsTab";
import { SkillsSettingsTab } from "./SkillsSettingsTab";
import { cn } from "@/lib/utils";
import { useNarrow } from "@/state/view-store";
import { UpdateConfirmDialog, UpdateSettingsTab, useUpdateMarked, VersionLine } from "@/features/update/UpdateView";

/**
 * Settings, in sections named for what they hold, in the order they are looked for: down a side list on a computer, in
 * a row of tabs on a phone. This PC's config.yaml is one draft for
 * the dialog, read with its hash when it opens: AI shows its AI and agents, General's Advanced options its limits, each
 * with the same save row, and General ends on the folder the server reads. Notifications and General's own values save
 * at once; Projects lists every project, archived ones marked, each opening its own settings, which are the project
 * dialog's, not here; App & phone guides installing the app and opening it from a phone; Resources is read-only.
 * Recommended skills installs and updates the skills setup offers; Update is where the app's update is read and done.
 */
export function SettingsDialog({ initialTab = "ai", request, focus }: { initialTab?: SettingsTab; request?: number; focus?: SettingsFocus } = {}) {
  const { t } = useTranslation("panels");
  const narrow = useNarrow();
  return (
    <PanelDialog title={t("settings.title")} size="large" wide heading={narrow} ownBody>
      <SettingsBody initialTab={initialTab} request={request} focus={focus} inDialog />
      <UpdateConfirmDialog />
    </PanelDialog>
  );
}

/** The top line of both columns on a computer: the dialog's title over the side list, the section's name over the page. */
const HEAD_ROW = "flex h-16 flex-none items-center";

const TABS = ["ai", "skills", "notifications", "projects", "general", "apps", "host", "update"] as const satisfies readonly SettingsTab[];

export function SettingsBody({ initialTab = "ai", request, focus, inDialog = false }: { initialTab?: SettingsTab; request?: number; focus?: SettingsFocus; inDialog?: boolean }) {
  const focusNotifications = focus === "notifications";
  const { t } = useTranslation("panels");
  const coarsePointer = useCoarsePointer();
  const narrow = useNarrow();
  const updateMarked = useUpdateMarked();
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
    <ServerDraftProvider show={setTab} focusCoordinatorAi={focus === "coordinatorAi" ? request ?? 0 : undefined}>
    <Tabs value={tab} orientation={narrow ? "horizontal" : "vertical"} onValueChange={(value) => setTab(value as SettingsTab)} className={cn("min-h-0 flex-1", !narrow && "flex-row")}>
      {/* A computer lists the sections down a tinted side, the dialog's title on its top line; a phone keeps them in a
          row that scrolls sideways, under the title. */}
      <div className={cn("flex-none px-6 narrow:px-4.5", !narrow && "flex w-56 flex-col border-e border-line bg-[color:color-mix(in_oklab,var(--ink)_3%,transparent)] px-3")}>
        {!narrow && <div className={cn(HEAD_ROW, "px-2")}>{inDialog ? <DialogTitle className="font-semibold">{t("settings.title")}</DialogTitle>
          : <h2 className="m-0 text-lg font-semibold">{t("settings.title")}</h2>}</div>}
        <div className={cn("border-b border-line", !narrow && "border-b-0 pt-1")}>
          <TabsList ref={list} className={cn("-mx-1 border-b-0", !narrow && "mx-0 flex-col items-stretch gap-0.5 overflow-visible py-0")}>
            {/* Mapped over TABS itself: i18n:extract reads each `settings.tabs.*` key from this constant list, not a filtered copy. */}
            {TABS.map((value) => availableTabs.includes(value) && <TabsTrigger key={value} value={value} className={cn(!narrow && "h-8 justify-start",
              // Update carries the gear's mark while something there waits for the person.
              value === "update" && updateMarked && "pe-5 before:absolute before:end-2 before:top-1/2 before:size-2 before:-translate-y-1/2 before:rounded-full before:bg-new")}>
              {t(`settings.tabs.${value}`)}
            </TabsTrigger>)}
          </TabsList>
        </div>
        {!narrow && <div className="mt-auto px-2 pb-5"><VersionLine /></div>}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The section's name on the title's line, at the title's size, with the close button at its end. */}
      {!narrow && <div className={cn(HEAD_ROW, "justify-between gap-3 px-8 pe-5")}>
        <h3 className="m-0 min-w-0 text-lg font-semibold">{t(`settings.tabs.${tab}`)}</h3>{inDialog && <DialogCloseButton />}</div>}
      <DialogBody ref={body} className={cn("flex flex-col border-t-0 pt-5", !narrow && "pt-1 [--pane-side:--spacing(8)]")}>
      {/* The two tabs showing the draft stay mounted while hidden, so a refused save can take the eye into either. */}
      <TabsContent value="ai" forceMount hidden={tab !== "ai"}>
        <AiSettingsTab />
      </TabsContent>
      <TabsContent value="skills">
        <SkillsSettingsTab />
      </TabsContent>
      <TabsContent value="notifications">
        <NotificationSettingsTab focusNotifications={focusNotifications} />
      </TabsContent>
      <TabsContent value="projects">
        <ProjectsSettingsTab />
      </TabsContent>
      <TabsContent value="general" forceMount hidden={tab !== "general"}>
        <GeneralSettingsTab><AdvancedServerOptions /></GeneralSettingsTab>
        <ServerFolderLines />
      </TabsContent>
      {availableTabs.includes("apps") && <TabsContent value="apps">
        <AppGuideTab />
      </TabsContent>}
      <TabsContent value="update">
        <UpdateSettingsTab />
      </TabsContent>
      <TabsContent value="host">
        <HostTab />
      </TabsContent>
      {/* On a phone at the foot of the box when the tab shown is short, after its last line when it is long; a computer keeps it under the side list. */}
      {narrow && <div className="mt-auto"><VersionLine /></div>}
      </DialogBody>
      </div>
    </Tabs>
    </ServerDraftProvider>
  );
}
