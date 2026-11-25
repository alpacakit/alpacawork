import { useDeferredValue, useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent, type Ref } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { chosenFolderSchema, folderNameProblem, madeFolderSchema, type Folders } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/data/client";
import { useWorkspaceInfo } from "@/data/queries";
import { api, resources } from "@/data/resources";
import { workspaceWriteBasis } from "@/data/connection";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { cn } from "@/lib/utils";
import { problemText } from "./problem-text";
import { ReadFailure } from "@/components/ui/loadable";

/** The most folders offered under the field while a path is typed (they scroll past the first few). */
const OFFERED = 50;
/** How long Choose waits for this PC's own chooser: past the server's own bound (10 minutes), so the server ends it. */
const CHOOSER_MS = 11 * 60_000;
/** A screen opened at a loopback name is on the server's own PC, which can show its own folder chooser. */
const onThisPc = () => ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

/** A typed path as the folder it is in and the start of the next name: `/a/b/we` is `/a/b/` and `we`. */
export function typedFolder(value: string): { folder: string; start: string } | null {
  if (!value.startsWith("/") && value !== "~" && !value.startsWith("~/")) return null;
  const at = value.lastIndexOf("/") + 1;
  return at === 0 ? { folder: "~/", start: "" } : { folder: value.slice(0, at), start: value.slice(at) };
}
const inside = (folder: string, name: string) => `${folder.replace(/\/+$/, "")}/${name}`;
/** A path as a person reads it, and as the field holds it (the server reads `~` as home): under home as ~/…. */
const fromHome = (path: string, home: string) => path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
/** What the server said was wrong, in the reader's words. */

/** Visible duplicates can be opened immediately; the disk checks names outside this list. */
export function newNameProblem(name: string, taken: readonly string[]) {
  const trimmed = name.trim();
  return folderNameProblem(trimmed) ?? (taken.includes(trimmed) ? "taken" : null);
}

/**
 * A field for a folder of this PC (where a project's code is), always filled with an absolute path (under home as ~/…,
 * which the server reads as home). Typed, the folders starting with the last part written are offered under it, and one
 * taken goes on to its own (↑↓ to move, Enter or Tab to take). Choose, on a screen opened on this PC, shows this PC's
 * own folder chooser; elsewhere, or where it cannot be shown, it opens a list to walk the folders instead: in, up, or
 * back along the path (by keys too), and the field follows the folder walked to, so what the form saves is what is
 * shown; Cancel puts back what the field had. The offers and the list read the server's one list of a folder's folders;
 * hidden ones are offered once a name starting with "." is typed.
 */
export function FolderInput({ value, onChange, onBlur, ref, className, placeholder, ...props }: Omit<ComponentProps<"input">, "value" | "onChange" | "onBlur"> & {
  value: string; onChange: (value: string) => void; ref?: Ref<HTMLInputElement>;
  /** The focus has left the field, Choose and the list. */
  onBlur?: () => void;
}) {
  const { t } = useTranslation("forms");
  const root = useWorkspaceInfo((info) => info.root);
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [walking, setWalking] = useState<string | null | false>(false);
  const queries = useQueryClient();
  // A new folder being named in the folder shown (null: none); what the server refused; the folder this field got by making it.
  const [naming, setNaming] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [makeFailure, setMakeFailure] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  // This PC's chooser being shown: aborting it closes the chooser (also when the field goes away).
  const [asking, setAsking] = useState<AbortController | null>(null);
  useEffect(() => () => asking?.abort(), [asking]);

  // Where looking starts (the server's rule), shown as the example.
  const start = useQuery({ ...resources.folders(root, null), enabled: placeholder === undefined });
  const typed = typedFolder(useDeferredValue(value));
  // A folder is read once and narrowed here as names are typed; only a folder too large to answer whole is asked
  // again with the start of the name. Hidden folders are read once a name starting with "." is typed.
  const looking = focused && typed !== null && walking === false;
  const hidden = typed?.start.startsWith(".") ? "." : "";
  const whole = useQuery({ ...resources.folders(root, typed?.folder ?? null, hidden), enabled: looking });
  const narrowed = useQuery({ ...resources.folders(root, typed?.folder ?? null, typed?.start ?? ""),
    enabled: looking && !!whole.data?.truncated && (typed?.start.length ?? 0) > hidden.length });
  const offer = { data: whole.data?.truncated && narrowed.data ? narrowed.data : whole.data };
  const offered: string[] = [];
  if (typed && offer.data) {
    const prefix = typed.start.toLowerCase();
    for (const name of offer.data.folders) {
      if (name.toLowerCase().startsWith(prefix) && name !== typed.start) {
        offered.push(name);
        if (offered.length === OFFERED) break;
      }
    }
  }
  const offering = focused && walking === false && dismissed !== value && offered.length > 0;
  // A name taken goes after the folder as the server read it: `~/co` becomes the absolute path.
  const take = (name: string) => {
    onChange(`${fromHome(inside(offer.data!.path, name), offer.data!.home)}/`);
    setActive(-1);
    // The name just taken is at the end of the field: show it.
    requestAnimationFrame(() => { if (input.current) input.current.scrollLeft = input.current.scrollWidth; });
  };

  const walk = useQuery({ ...resources.folders(root, walking || null), enabled: walking !== false });
  // The last folder read stays in view while another is read or cannot be.
  const [shown, setShown] = useState<Folders | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // The folder that could not be read: Retry reads it again (the list stays on the last one read meanwhile).
  const [failedAt, setFailedAt] = useState<string | null>(null);
  useEffect(() => { if (walking !== false && walk.data) setShown(walk.data); }, [walking, walk.data]);
  const list = useRef<HTMLDivElement>(null);
  const folders = useRef<HTMLUListElement>(null);
  // What the field had when the list opened (Cancel puts it back), whether the person has walked since (the field then
  // follows), and whether the focus was in the list when it moved (it then goes on to the folder shown).
  const before = useRef<string | null>(null);
  const walked = useRef(false);
  const refocus = useRef(false);
  const go = (path: string | null) => {
    setReason(null);
    setNaming(null);
    if (walking === false) { before.current = value; walked.current = false; }
    else { walked.current = true; refocus.current = !!list.current?.contains(document.activeElement); }
    setWalking(path);
  };
  const close = (used?: string) => {
    setNaming(null);
    const restore = used === undefined && walking !== false && walked.current ? before.current : null;
    setWalking(false);
    setShown(null);
    setReason(null);
    setDismissed(used ?? restore ?? value);
    if (used !== undefined) onChange(used);
    else if (restore !== null) onChange(restore);
    requestAnimationFrame(() => input.current?.focus());
  };
  // Esc ends the naming first, then the list.
  useEscapeLayer(offering || walking !== false, ESCAPE_LAYER.input, () => naming !== null ? stopNaming() : close());
  const nameInput = useRef<HTMLInputElement>(null);
  // Set while a folder is being made: a second press before the screen draws again sends nothing.
  const makingNow = useRef(false);
  // Naming ended, the focus goes back to the row it started from (a field removed with the focus in it would give the
  // focus to the dialog).
  const stopNaming = () => {
    setNaming(null);
    setMakeFailure(null);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>("[data-folder-new]")?.focus());
  };
  const startNaming = () => {
    setNaming("");
    setMakeFailure(null);
    requestAnimationFrame(() => { list.current?.querySelector("ul")?.scrollTo({ top: 0 }); nameInput.current?.focus(); });
  };
  const problem = naming === null || !shown ? null : newNameProblem(naming, shown.folders);
  const nameProblems = {
    slash: t("folderInput.problem.slash"), dots: t("folderInput.problem.dots"),
    long: t("folderInput.problem.long"), taken: t("folderInput.problem.taken"),
  };
  // Made, the new folder is the field's: the list closes on it, as Use would.
  const make = async () => {
    if (!shown || naming === null || problem || makingNow.current) return;
    makingNow.current = true;
    setMaking(true);
    setMakeFailure(null);
    try {
      const { path } = await api.request("workspace/folders/new", madeFolderSchema, undefined,
        { path: shown.path, name: naming.trim() }, undefined, workspaceWriteBasis());
      await queries.invalidateQueries({ queryKey: ["folders", root] });
      setMade(fromHome(path, shown.home));
      // Made, it is walked into like any folder: the field follows, and more can be made inside it.
      refocus.current = true;
      walked.current = true;
      setNaming(null);
      setWalking(path);
    } catch (error) {
      setMakeFailure(problemText(error));
      requestAnimationFrame(() => nameInput.current?.focus());
    } finally { makingNow.current = false; setMaking(false); }
  };
  // The list starts at the folder the field names (as does this PC's chooser).
  const written = typed ? value.replace(/\/+$/, "") || "/" : null;
  const choose = async () => {
    if (!onThisPc()) return go(written);
    const ask = new AbortController();
    setAsking(ask);
    try {
      const query = new URLSearchParams({ title: t("folderInput.chooserTitle"), ...written ? { path: written } : {} });
      const { path } = await api.readWithin(`workspace/folders/choose?${query}`, chosenFolderSchema, CHOOSER_MS, ask.signal);
      const home = start.data?.home;
      const chosen = path === null ? null : home ? fromHome(path, home) : path;
      if (chosen !== null) { onChange(chosen); setMade(null); setDismissed(chosen); }
      requestAnimationFrame(() => input.current?.focus());
    } catch {
      // Not shown (no desktop here, or it failed): the list instead.
      if (!ask.signal.aborted) go(written);
    } finally { setAsking(current => current === ask ? null : current); }
  };
  // Choose starts at the folder the field names; one that is not there yet (half typed) starts at the nearest above it.
  // A folder that cannot be read is not entered: the list stays where it was and says why.
  useEffect(() => {
    if (!walk.isError || walking === false) return;
    const missing = walk.error instanceof ApiError
      && walk.error.issues.some(issue => issue.code === "missing_directory" || issue.code === "not_directory");
    if (!shown && missing && walking && walking !== "/") { setWalking(walking.replace(/\/[^/]*\/?$/, "") || "/"); return; }
    setReason(problemText(walk.error));
    setFailedAt(walking || null);
    if (shown) setWalking(shown.path);
  }, [walk.isError, walk.error, shown, walking]);
  // The offer chosen by the keys stays in view.
  useEffect(() => { document.getElementById(`${id}-offered-${active}`)?.scrollIntoView({ block: "nearest" }); }, [id, active]);
  // A long path shows its end, the folder's own name, while the field is not being written in; so does the path walked.
  useEffect(() => { if (!focused && input.current) input.current.scrollLeft = input.current.scrollWidth; }, [focused, value]);
  // A folder shown: the field follows it once the person has walked; the list starts at its top, or, up from a folder,
  // at that folder's row; the focus, when it was in the list, goes to that row or the first; the list opened comes into
  // view whole.
  const [cameFrom, setCameFrom] = useState<string | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    // Set only when the folder asked for has been read (or the nearest above one not there yet).
    if (!shown) return;
    if (walked.current && fromHome(shown.path, shown.home) !== value) onChange(fromHome(shown.path, shown.home));
    const rows = folders.current;
    if (rows) rows.scrollTop = 0;
    const from = cameFrom ? rows?.querySelector<HTMLElement>(`[data-folder-name="${CSS.escape(cameFrom)}"]`) : null;
    from?.scrollIntoView({ block: "nearest" });
    if (refocus.current || from) (from ?? rows?.querySelector<HTMLElement>("[data-folder-name]") ?? list.current?.querySelector<HTMLElement>("[data-folder-use]"))?.focus();
    refocus.current = false;
    setCameFrom(null);
    if (!opened.current) { opened.current = true; list.current?.scrollIntoView({ block: "nearest" }); }
    // Only a new folder shown moves the field and the focus; the field's own changes do not.
  }, [shown]);
  useEffect(() => { if (walking === false) opened.current = false; }, [walking]);
  // In the list, the arrows move between folders, → or Enter goes in, ← or Backspace goes up; Tab leaves it.
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-folder-name]");
    if (!row || !shown) return;
    const all = [...folders.current!.querySelectorAll<HTMLElement>("[data-folder-name]")];
    const at = all.indexOf(row);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key as "Home"];
    if (to !== undefined) { event.preventDefault(); all[Math.max(0, Math.min(all.length - 1, to))]?.focus(); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); row.click(); return; }
    if ((event.key === "ArrowLeft" || event.key === "Backspace") && shown.parent) { event.preventDefault(); refocus.current = true; back(shown.parent); }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!offering || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // From the field (-1) through the offers and back to the field.
      setActive((at) => at + step >= offered.length ? -1 : at + step < -1 ? offered.length - 1 : at + step);
    }
    // Enter and Tab take the chosen offer, or the only one; with several and none chosen, Enter only closes them
    // (the form is sent by the next Enter, never while offers are showing).
    const tab = event.key === "Tab" && !event.shiftKey;
    if (!tab && event.key !== "Enter") return;
    const pick = active >= 0 ? offered[active] : offered.length === 1 && typed!.start ? offered[0] : undefined;
    if (pick) { event.preventDefault(); take(pick); }
    else if (event.key === "Enter") { event.preventDefault(); setDismissed(value); }
  };

  // The path as steps back: from home as ~, else from /; deeper than two, the steps before the folder holding this
  // one are one "…" (to the nearest of them), so the folder you are in and the one above it can always be read.
  const crumbs = (path: string, home: string) => {
    const base = path === home || path.startsWith(`${home}/`) ? home : "/";
    const steps = path.slice(base.length).split("/").filter(Boolean);
    const at = (count: number) => count ? inside(base, steps.slice(0, count).join("/")) : base;
    const first = Math.max(0, steps.length - 3);
    const near = steps.slice(first).map((step, index) => ({ label: step, path: at(first + index + 1) }));
    return [{ label: base === home ? "~" : "/", path: base },
      ...steps.length > 3 ? [{ label: "…", path: at(steps.length - 3) }] : [], ...near];
  };
  // Back to a folder above, the focus goes to the row of the folder on the way to where you were.
  const back = (to: string) => {
    if (shown) setCameFrom(shown.path.slice(to.replace(/\/+$/, "").length + 1).split("/")[0] || null);
    go(to);
  };
  const row = "flex min-h-8 w-full items-center gap-2 rounded-xs px-2 text-left text-sm hover:bg-hover narrow:min-h-control-lg";

  // The field, Choose and the list are one control: it is left (onBlur) only when the focus goes outside all of them.
  return <div className={cn("flex flex-col gap-1.5", className)}
    onBlur={(event) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      // Left, a folder is written without the "/" a taken offer ends in.
      if (value.length > 1 && value.endsWith("/")) onChange(value.replace(/\/+$/, ""));
      onBlur?.();
    }}>
    {/* The offers lie over what is below, so the dialog keeps its height when they come and go (a press elsewhere
        hides them as it lands, and would otherwise move its target). */}
    <div className="relative flex gap-2">
      <Input {...props} value={value} dir="ltr" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
        ref={(node) => { input.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node; }}
        placeholder={placeholder ?? (start.data ? t("folderInput.example", { path: fromHome(inside(start.data.path, "my-work"), start.data.home) }) : undefined)}
        role="combobox" aria-autocomplete="list" aria-expanded={offering} aria-controls={offering ? `${id}-offered` : undefined}
        aria-activedescendant={offering && active >= 0 ? `${id}-offered-${active}` : undefined}
        className="min-w-0 flex-1 font-mono"
        onChange={(event) => {
          // Typing goes back to the offers: the list is left where it is, without putting back what it had.
          if (walking !== false) { setWalking(false); setShown(null); setNaming(null); setReason(null); }
          onChange(event.target.value); setActive(-1); setDismissed(null); setMade(null);
        }}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown} />
      <Button type="button" variant="outline" aria-expanded={walking !== false} data-folder-walk disabled={asking !== null}
        className="aria-expanded:border-muted aria-expanded:bg-hover narrow:min-h-control-lg"
        onClick={() => walking === false ? void choose() : close()}>
        <Icon name="folder" className="size-4" />{t("folderInput.choose")}
      </Button>
      {/* Hidden, not removed, when the field is left: a node removed while the focus is between two elements makes
          the dialog take the focus back to itself (Radix FocusScope), so Tab would not reach the next control. */}
      {offered.length > 0 && <ul id={`${id}-offered`} role="listbox" hidden={!offering} aria-label={t("folderInput.offered")}
        className="absolute inset-x-0 top-full z-10 m-0 mt-1 max-h-[13.5rem] list-none overflow-auto rounded-sm border border-lit-line bg-raised p-1 shadow-float">
      {offered.map((name, at) => <li key={name} id={`${id}-offered-${at}`} role="option" aria-selected={at === active}
        onMouseDown={(event) => event.preventDefault()} onClick={() => take(name)}
        className={cn(row, "cursor-pointer font-mono", at === active && "bg-hover")}>
        <Icon name="folder" className="size-3.5 flex-none text-soft" />
        <span className="min-w-0 truncate" title={name}>{name}</span>
      </li>)}
      </ul>}
    </div>
    {/* The chooser may open behind this window, or on a display this person does not see: the list stays one press away. */}
    {asking && <p data-folder-asking role="status" className="m-0 flex flex-wrap items-center gap-x-2 text-xs text-muted">
      {t("folderInput.choosing")}
      <button type="button" className="text-ink underline underline-offset-2" onClick={() => { asking.abort(); go(written); }}>
        {t("folderInput.chooseHere")}</button>
    </p>}
    {walking === false && made !== null && made === value && <p data-folder-made className="m-0 flex items-center gap-1 text-xs text-muted">
      <Icon name="check" className="size-3.5 text-done" />{t("folderInput.made")}</p>}
    {walking !== false && <div ref={list} data-folder-list className="flex flex-col rounded-sm border border-line bg-lit">
      {/* One line however deep: where it starts (~ or /) always shows, the steps between give way first, and the
          folder you are in is cut last. The list below never moves. */}
      <div className="flex flex-none items-center gap-0.5 border-b border-line px-1">
      <Button type="button" variant="ghost" size="icon" aria-label={t("folderInput.up")} title={t("folderInput.up")} disabled={!shown?.parent}
        className="flex-none narrow:size-11" onClick={() => back(shown!.parent!)}><Icon name="arrowUp" className="size-3.5" /></Button>
      <nav aria-label={t("folderInput.path")}
        className="flex h-9 min-w-0 flex-1 items-center gap-0.5 overflow-hidden font-mono text-sm whitespace-nowrap narrow:h-11">
        {shown && crumbs(shown.path, shown.home).map((crumb, at, all) => {
          const last = at === all.length - 1;
          // The folder above keeps its name up to almost half the line (a third on a phone); the folder you are in
          // takes the rest.
          return <span key={crumb.path} className={cn("flex min-w-0 items-center gap-0.5",
            at === 0 || crumb.label === "…" ? "flex-none" : last ? "shrink" : "max-w-[45%] flex-none narrow:max-w-[32%]")}>
            {at > 0 && <Icon name="right" className="size-3 flex-none text-soft" />}
            {last
              ? <span aria-current="location" className="min-w-0 truncate px-1.5 font-semibold">{crumb.label}</span>
              : <button type="button" onClick={() => back(crumb.path)} title={crumb.path}
                className="min-h-8 min-w-8 max-w-full truncate rounded-xs px-1.5 text-muted hover:bg-hover hover:text-ink narrow:min-h-control-lg narrow:min-w-11">{crumb.label}</button>}
          </span>;
        })}
      </nav>
      <Button type="button" variant="ghost" size="icon" data-folder-new aria-label={t("folderInput.make")} title={t("folderInput.make")}
        disabled={!shown || naming !== null} className="flex-none narrow:size-11" onClick={startNaming}><Icon name="plus" className="size-3.5" /></Button>
      </div>
      {/* One height for every folder (cut through a row, so a list that goes on looks it): walking never resizes the
          dialog. What cannot be read and what is left out are said inside it. */}
      <ul ref={folders} aria-label={t("folderInput.inside")} onKeyDown={onListKey}
        className="m-0 h-[13.5rem] list-none overflow-auto p-1 narrow:h-[15rem]">
        {reason && <li className="px-2 py-1.5"><ReadFailure what={reason} retry={() => (walking || null) === failedAt
          // Still at the folder that could not be read: read it again; the failure stands until the answer says otherwise.
          ? void walk.refetch().then(result => { if (!result.isError) setReason(null); })
          : go(failedAt)} /></li>}
        {/* A new folder is named at the top of the folders it joins. */}
        {shown && naming !== null && <li data-folder-naming className="my-0.5 flex flex-col gap-1 rounded-xs border border-line bg-bg p-1.5">
          <div className="flex items-center gap-1.5">
            <Icon name="folder" className="ml-0.5 size-3.5 flex-none text-soft" />
            <Input ref={nameInput} value={naming} aria-label={t("folderInput.name")} placeholder={t("folderInput.placeholder")} disabled={making}
              dir="auto" autoComplete="off" spellCheck={false} autoCapitalize="off" autoCorrect="off"
              aria-invalid={!!(problem && problem !== "empty") || !!makeFailure}
              className="h-8 min-w-0 flex-1 font-mono narrow:h-control-lg"
              onChange={(event) => { setNaming(event.target.value); setMakeFailure(null); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                // Enter makes the folder, never sends the dialog's form.
                event.preventDefault();
                void make();
              }} />
            <Button type="button" variant="outline" data-folder-make disabled={!!problem || making}
              className="narrow:min-h-control-lg" onClick={() => void make()}>{making ? t("folderInput.creating") : t("folderInput.create")}</Button>
            <Button type="button" variant="ghost" size="icon" aria-label={t("folderInput.cancel")} title={t("folderInput.cancel")} disabled={making}
              className="flex-none narrow:size-11" onClick={stopNaming}><Icon name="close" className="size-3.5" /></Button>
          </div>
          {/* Where it goes, or why it cannot; a name already there offers that folder instead. */}
          <p className={cn("m-0 flex flex-wrap items-center gap-x-2 px-0.5 text-xs", problem && problem !== "empty" || makeFailure ? "text-error" : "text-muted")}>
            {makeFailure ?? (problem && problem !== "empty" ? nameProblems[problem]
              : t("folderInput.where", { path: fromHome(shown.path, shown.home) }))}
            {problem === "taken" && <button type="button" className="text-ink underline underline-offset-2"
              onClick={() => go(inside(shown.path, naming.trim()))}>{t("folderInput.openExisting")}</button>}
          </p>
        </li>}
        {/* One stop for Tab: the first folder; the arrows move between them. */}
        {shown?.folders.map((name, at) => <li key={name}><button type="button" data-folder-name={name} tabIndex={at === 0 ? 0 : -1}
          onClick={() => go(inside(shown.path, name))} className={cn(row, "font-mono focus-visible:bg-hover")}>
          <Icon name="folder" className="size-3.5 flex-none text-soft" />
          <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
          <Icon name="right" className="size-3 flex-none text-soft" />
        </button></li>)}
        {shown && !shown.folders.length && <li className="px-2 py-1.5"><Message tone="empty" size="line" title={t("folderInput.empty")} /></li>}
        {!shown && walk.isFetching && <li className="px-2 py-1.5"><Message tone="waiting" size="line" live title={t("folderInput.reading")} /></li>}
        {shown?.truncated && <li className="px-2 py-1.5"><Message tone="info" size="line" title={t("folderInput.truncated", { limit: shown.folders.length })} /></li>}
      </ul>
      <div className="flex items-center justify-end gap-2 border-t border-line p-1.5">
        <Button type="button" variant="ghost" className="narrow:min-h-control-lg" onClick={() => close()}>{t("folderInput.close")}</Button>
        {/* Not the dialog's own primary button: one dark button says where the form ends. */}
        <Button type="button" variant="outline" data-folder-use className="narrow:min-h-control-lg" disabled={!shown}
          onClick={() => close(fromHome(shown!.path, shown!.home))}>{t("folderInput.use")}</Button>
      </div>
    </div>}
  </div>;
}
