import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, HEAD_MARK } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { useAttachmentBytes } from "@/data/queries";
import { taskFileUrl, taskFilesLink } from "@/data/task-file-url";
import type { TaskDetail } from "@/data/types";
import {
  WORK_FOLDER, baseName, folderOf, folderSheet, isMedia, listFolder, mediaKind, showable, visibleFileMedia,
  type ListedFile, type MediaSet, type TaskFile,
} from "@/domain/task-files";
import { viewerAddress } from "@/domain/viewer-target";
import { formatLogTime } from "@/domain/time";
import { textClip, writeClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { closeView } from "@/state/history-step";
import { useViewStore } from "@/state/view-store";
import { openView } from "../viewer/Viewer";
import { SummaryCounts, useDiffNaming } from "../diff/DiffPages";
import { DiffTitle } from "../diff/commits";
import { UrlImageSlider, useOpenUrlImage, type SliderImage } from "../ImageSlider";
import { AudioTile, VideoPoster } from "../TaskMedia";
import { useFileShelves } from "./file-shelves";

/**
 * The Files tab as a review sheet. The deliverables (fileShelves) are on one page in the order a reviewer reads them:
 * the files the Deliverables field lists, under its names, then documents, then images grouped into comparable sets with
 * every version visible; each part newest first. Folders holding deliverables are filters above the sheet, the work files
 * the one filter set apart. Opening an image uses the shared slider; a document is read in the viewer (openView),
 * beside the sheet on a wide computer; the URL's `path` is the folder either way.
 */
export function FilesTab({ task, path }: { task: TaskDetail; path: string }) {
  const setFilePath = useViewStore(state => state.setFilePath);
  return <Sheet task={task} folder={folderOf(path)} onOpen={next => setFilePath(task.id, next)} />;
}

/** The link to what is open, for pasting into a report or a chat. */
const copyLink = (taskId: string, path: string) => void writeClip(textClip(new URL(taskFilesLink(taskId, path), location.origin).href));

/** The media heading: one kind's own name, or the general one for a mix. */
const HEADINGS: Record<string, "files.images" | "files.videos"> = { image: "files.images", video: "files.videos" };

function Sheet({ task, folder, onOpen }: { task: TaskDetail; folder: string; onOpen: (path: string) => void }) {
  const { t } = useTranslation("reader");
  const [shown, setShown] = useState(100);
  const openImage = useOpenUrlImage();
  const maxBytes = useAttachmentBytes();
  const shelves = useFileShelves(task)!;
  const top = useMemo(() => listFolder("", shelves.deliverables).folders.filter(item => item.path !== WORK_FOLDER), [shelves]);
  const sheet = useMemo(() => folderSheet(shelves, folder), [shelves, folder]);
  const inView = sheet.files;
  // The chip lit is the shelf shown: work files, or the deliverables' top folder where it has a chip.
  const chip = sheet.work ? WORK_FOLDER : top.find(item => folder.startsWith(item.path))?.path ?? "";
  // The listed files of this sheet lead it, each once; the rest follow as documents and media sets.
  const listed = useMemo(() => shelves.listed.filter(item => inView.includes(item.file)), [shelves, inView]);
  const rest = useMemo(() => inView.filter(file => !listed.some(item => item.file === file)), [inView, listed]);
  const documents = useMemo(() => rest.filter(file => !isMedia(file.name)), [rest]);
  const sets = useMemo(() => visibleFileMedia(rest), [rest]);
  const slides = useMemo(() => {
    const images: SliderImage[] = [];
    for (const { file, label } of listed) if (isMedia(file.name)) images.push({
      id: file.name, path: file.name, alt: label, src: taskFileUrl(task.id, file.name, file.revision), showable: showable(file, maxBytes),
    });
    for (const set of sets) for (const item of set.items) images.push({
      id: item.file.name,
      path: item.file.name,
      alt: set.single ? baseName(item.file.name) : [set.label, versionOf(item, set, t)].filter(Boolean).join(" "),
      src: taskFileUrl(task.id, item.file.name, item.file.revision),
      showable: showable(item.file, maxBytes),
    });
    return images;
  }, [listed, sets, t, task.id, maxBytes]);
  // The work files' list holds files outside work/ too: those keep their whole path.
  const relative = (name: string) => name.startsWith(folder) ? name.slice(folder.length) : name;
  return <section aria-label={task.title} className="flex flex-col gap-5 pt-2">
    <UrlImageSlider images={slides} />
    {/* The chips fold within their own box, so the copy stays at the end of the first line. */}
    <div role="toolbar" aria-label={t("files.path")} className="flex items-start gap-1.5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      <Chip path="" current={chip === ""} onClick={() => onOpen("")} label={t("files.all")} count={shelves.deliverables.length} />
      {top.map(item => <Chip key={item.path} path={item.path} current={chip === item.path} onClick={() => onOpen(item.path)} label={baseName(item.path)} count={item.count} />)}
      {shelves.work.length > 0 && <Chip path={WORK_FOLDER} current={chip === WORK_FOLDER} onClick={() => onOpen(WORK_FOLDER)} label={t("files.work")} count={shelves.work.length} quiet />}
      </div>
      <Button variant="ghost" size="icon" aria-label={t("files.copyLink")} title={t("files.copyLink")} className={cn(HEAD_MARK, "flex-none")} onClick={() => copyLink(task.id, folder)}>
        <Icon name="copy" className="size-3.5" />
      </Button>
    </div>
    {folder !== chip && <p className="-mt-3 m-0 text-sm text-muted">{t("files.inFolder", { folder })}</p>}
    {!inView.length && (shelves.work.length && folder === "" ? <Message tone="empty" icon="folder" title={t("files.onlyWork")} description={t("files.onlyWorkHint")} />
      : <Message tone="empty" icon="folder" title={t("files.empty")} />)}
    {listed.length > 0 && <ul className="m-0 flex list-none flex-col border-t border-rule p-0">
      {listed.map(item => <li key={item.file.name} className="border-b border-rule">
        {isMedia(item.file.name) ? <MediaRow task={task} item={item} path={relative(item.file.name)} onOpen={event => openImage(event.currentTarget, item.file.name)} />
          : <DocumentRow task={task} file={item.file} title={item.label} name={relative(item.file.name)} />}
      </li>)}
    </ul>}
    {documents.length > 0 && <div>
      <h4 className="m-0 mb-1 text-sm font-normal text-muted">{t("files.documents")}</h4>
      <ul className="m-0 flex list-none flex-col border-t border-rule p-0">
        {documents.slice(0, shown).map(file => <li key={file.name} className="border-b border-rule">
          <DocumentRow task={task} file={file} name={<><span className="text-muted">{folderOf(relative(file.name))}</span>{baseName(file.name)}</>} />
        </li>)}
      </ul>
      {documents.length > shown && <Button variant="quiet" className="mt-1" onClick={() => setShown(count => count + 100)}>
        {t("ruleTab.more", { shown, total: documents.length })}
      </Button>}
    </div>}
    {sets.length > 0 && <div className="flex flex-col gap-4">
      <h4 className="m-0 -mb-2 text-sm font-normal text-muted">{t(HEADINGS[[...new Set(sets.flatMap(set => set.items.map(item => mediaKind(item.file.name))))].join()] ?? "files.media")}</h4>
      {sets.map(set => {
        // A set is named by its name and folder; loose media by their folder, or as the others in the Task folder.
        const where = relative(set.folder);
        const name = !set.single ? set.label : where ? t("files.otherIn", { folder: where.slice(0, -1) }) : t("files.otherMedia");
        return <div key={set.key} className="flex flex-col gap-1.5">
          {/* A heading is needed only beside another set. */}
          {!(set.single && sets.length === 1) && <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-md font-medium">{name}</span>
            {!set.single && where && where !== `${set.label}/` && <span className="truncate text-sm text-muted">{where}</span>}
          </div>}
          {/* Every picture shows its own time under its name, as the rows do, in cells of one size, so none hides off the edge. */}
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-2 gap-y-3 p-0">
            {set.items.map(item => <li key={item.file.name} className="min-w-0">
              <button type="button" className="group flex w-full min-w-0 flex-col gap-0.5 rounded-md p-0 text-left" onClick={event => openImage(event.currentTarget, item.file.name)}
                aria-label={baseName(item.file.name)}>
                <span className="mb-0.5 block aspect-[4/3] w-full overflow-hidden rounded-md border border-line bg-bg group-hover:border-lit-line">
                  <Thumb task={task} file={item.file} className="size-full" />
                </span>
                <span className="w-full truncate text-xs">{set.single ? baseName(item.file.name) : versionOf(item, set, t)}</span>
                <span className="text-xs text-muted"><FileMeta file={item.file} /></span>
              </button>
            </li>)}
          </ul>
        </div>;
      })}
    </div>}
  </section>;
}

/** A chip opens the sheet of its `path`. */
function Chip({ path, current, onClick, label, count, quiet }: { path: string; current: boolean; onClick: () => void; label: string; count: number; quiet?: boolean }) {
  return <Button variant="outline" data-files-chip={path} aria-pressed={current} onClick={onClick}
    className={cn("min-h-control-xs gap-1.5 rounded-full px-3 text-sm",
      current ? "border-ink bg-ink text-bg hover:bg-ink" : quiet ? "border-dashed bg-transparent text-muted" : "bg-transparent")}>
    {label}<span className={cn("tabular-nums", current ? "text-inverse-muted" : "text-muted")}>{count}</span>
  </Button>;
}

/** What tells a version from the others of its set: the facets that vary among them, else its file's extension. */
const versionOf = (item: MediaSet["items"][number], set: MediaSet, t: (key: string) => string) => {
  let version = "";
  for (const facet of set.varies) {
    const value = item.facets[facet] && t(`files.facet.${item.facets[facet]}`);
    if (value) version += (version ? " " : "") + value;
  }
  return version || (item.file.name.split(".").at(-1)?.toUpperCase() ?? "");
};

/**
 * A document's row; it opens the document in the viewer. A report diff's leads with its commits' title, by which it is
 * told from the others (its file is named by a hash), or how much it changes where its file names no commit; its file's
 * name under it. The row of the document read now is lit, and pressed again closes it, as a report's diff row does.
 */
function DocumentRow({ task, file, title, name }: { task: TaskDetail; file: TaskFile; title?: string; name: ReactNode }) {
  const naming = useDiffNaming(task.id, file);
  const heading = title !== undefined ? <span className="min-w-0 truncate">{title}</span>
    : naming && (naming.title ? <DiffTitle title={naming.title} className="min-w-0 truncate" /> : <SummaryCounts summary={naming.summary} className="min-w-0" />);
  const shown = useViewStore(state => state.view) === viewerAddress(task.id, file.name);
  return <Button variant="ghost" aria-current={shown || undefined} data-file-row={file.name}
    className={cn("flex min-h-control-md w-full min-w-0 items-center justify-start gap-2.5 rounded-none px-1 text-left text-base active:bg-press", shown && "bg-hover")}
    onClick={() => shown ? closeView() : openView(task.id, file.name)}>
    <Icon name="file" className="size-4 text-muted" />
    {heading ? <TwoLines heading={heading} name={name} /> : <span className="min-w-0 flex-1 truncate">{name}</span>}
    <span className="text-sm text-muted"><FileMeta file={file} /></span>
  </Button>;
}

/** A row's name over its file's path in small letters. */
const TwoLines = ({ heading, name }: { heading: ReactNode; name: ReactNode }) => <span className="flex min-w-0 flex-1 flex-col py-1">
  {heading}
  <span className="min-w-0 truncate text-xs text-muted">{name}</span>
</span>;

/** A listed picture's, video's or sound's row, as a document's but led by its small picture; it opens in the slider. */
function MediaRow({ task, item, path, onOpen }: { task: TaskDetail; item: ListedFile; path: string; onOpen: (event: MouseEvent<HTMLElement>) => void }) {
  return <Button variant="ghost" data-file-row={item.file.name} aria-label={item.label}
    className="flex min-h-control-md w-full min-w-0 items-center justify-start gap-2.5 rounded-none px-1 text-left text-base active:bg-press"
    onClick={onOpen}>
    <span className="block h-10 w-14 flex-none overflow-hidden rounded-sm border border-line bg-bg">
      <Thumb task={task} file={item.file} className="size-full" />
    </span>
    <TwoLines heading={<span className="min-w-0 truncate">{item.label}</span>} name={path} />
    <span className="text-sm text-muted"><FileMeta file={item.file} /></span>
  </Button>;
}

/** The time a file was written, or why it cannot be read. */
function FileMeta({ file }: { file: TaskFile }) {
  const { t } = useTranslation("reader");
  return file.readable === false ? <span className="text-warn">{t("ruleTab.readFailed")}</span> : <WrittenAt at={file.at} />;
}

/** A time a file was written, as the rows show it. */
function WrittenAt({ at }: { at: string }) {
  const { i18n } = useTranslation("reader");
  return <time dateTime={at}>{formatLogTime(at, i18n.language)}</time>;
}

/** A picture of a file, or a quiet placeholder when it cannot be shown here. */
function Thumb({ task, file, className }: { task: TaskDetail; file: TaskFile; className?: string }) {
  const maxBytes = useAttachmentBytes();
  if (!showable(file, maxBytes))
    return <span className={cn("grid place-items-center text-muted", className)}><Icon name="image" className="size-5" /></span>;
  const kind = mediaKind(file.name);
  if (kind === "audio") return <AudioTile className={cn(className, "aspect-square")} />;
  const src = taskFileUrl(task.id, file.name, file.revision);
  if (kind === "video") return <VideoPoster src={src} className={className} />;
  return <img className={cn("object-contain", className)} loading="lazy" decoding="async" src={src} alt="" draggable={false} />;
}
