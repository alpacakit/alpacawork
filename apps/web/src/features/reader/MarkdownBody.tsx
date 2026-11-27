import { openView } from "./viewer/Viewer";
import { Message } from "@/components/ui/message";
import { markdownDocument, markdownMediumId, type InlineContent, type List } from "@/domain/markdown";
import { CodeBlock } from "./CodeBlock";
import { CELL_FLOOR, TableFrame } from "./TableFrame";
import type { DiffSource } from "./diff/DiffSummary";
import { FENCE_PARTS, FILE_PARTS, fenceLabel } from "./embeds";
import { useQuery } from "@tanstack/react-query";
import { createContext, createElement, useContext, useMemo, Fragment, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TASK_ID_PATTERN, fenceKind, fileKind, reportEmbed } from "@alpacawork/contract";
import type { TaskDetail } from "@/data/types";

import { resolveReference, taskAtAddress } from "@/domain/tasks";
import { useAttachmentBytes, useEveryTaskIndex, useWorkspaceInfo } from "@/data/queries";
import { savedFileLink, taskFileUrl, taskFilesLink } from "@/data/task-file-url";
import { FileLinkAnchor } from "./FileLinkAnchor";
import { isMedia, mediaKind, showable } from "@/domain/task-files";
import { ExpandVideo, mediaUnavailable, pauseTaskMedia, TaskAudio, TaskVideo, VideoPoster } from "./TaskMedia";
import { BARE_PATH, type LocalTarget } from "@/domain/local-path";
import { VOID_TAGS, addressTarget, codeTarget, nodeReading, pathTarget, writtenTarget, type Reading } from "@/domain/file-references";
import { bareUrls, webTarget, type FoundUrl } from "@/domain/web-link";
import { openScreenLink } from "@/state/bootstrap";
import { useViewStore } from "@/state/view-store";
import { followReference } from "@/state/reader-position";
import { textClip, writeClip } from "@/lib/clipboard";
import { useSurfaceDocument } from "@/lib/surface";
import { cn } from "@/lib/utils";
import { CONTAINERS, decodeEntities, htmlPieces, headingAnchor, htmlNodes, inlineNodes, nodeWords, type InlineNode } from "@/domain/markdown";
/** Where a Markdown text's blocks go inside an HTML block that leaves folds or sections open: one list per open one, outermost first. */
type Inners = ReactNode[][];
import { usePrefetch } from "@/data/prefetch";
import { resources } from "@/data/resources";
import { PROSE_MEASURE } from "@/components/ui/prose";
import { CapCentred } from "@/components/ui/text-mark";
import { useTaskCardOn } from "@/features/coordinator/TaskCard";
import { useImageViewer, useOpenUrlImage, type SliderImage } from "./ImageSlider";

/** What Markdown reads of the Task it is written in: its ID, title and files. Narrow, so a row holding the same three
 * is not drawn again when anything else of its Task changes (ReportFeed). */
export type MarkdownTask = Pick<TaskDetail, "id" | "title" | "files">;

export type GalleryImage = SliderImage & { reportKey: string };

/** A managed file's display contract, independent of the Task or conversation that owns it. */
/** `src` is a managed file's address (a Task's or the coordinator's), `href` where its name leads on this screen. */
/** A published file a body names. `removed`: it was there and has been cleaned away (said so, with nothing to open). */
export type MarkdownFile = { path: string; name: string; src: string | null; href: string | null; size: number; readable?: false; removed?: true };

/** One body owns opening; the feed can supply its wider gallery and URL identity. */
const MarkdownGallery = createContext<{
  open: (from: HTMLElement | null, id: string) => void;
} | null>(null);

/** Where a written address is a file: a managed Task URL or a local reference, the same file owner either way. */
const fileTarget = (href: string, task: MarkdownTask | null, root: string | null, sourceFile: string | undefined) =>
  writtenTarget(href, { task, root, sourceFile, origin: location.origin });

/** A press that is the page's to take: a modified or other-button press stays the browser's. */
const plainPress = (event: React.MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function imageTarget(href: string, task: MarkdownTask | null, root: string | null, sourceFile: string | undefined,
  report: boolean, files: MarkdownFile[] | undefined): MarkdownFile | LocalTarget | null {
  const published = files?.find(file => file.path === href);
  if (published) return published;
  const local = fileTarget(href, task, root, sourceFile);
  if (local) return local;
  const embed = report && task ? reportEmbed(href) : null;
  return embed && task ? { kind: "task", id: task.id, path: embed.path } : null;
}

/**
 * The Task file a paragraph of only `![…](path)` embeds when its kind draws such a paragraph as one piece (FILE_PARTS'
 * ownParagraph: a diff card), in a report, a body or a note alike. A Task file the Task does not hold is still its
 * source, so the piece says it is missing where it would be.
 */
function ownParagraphSource(text: string, task: MarkdownTask | null, root: string | null, sourceFile: string | undefined,
  report: boolean, files: MarkdownFile[] | undefined): { kind: keyof typeof FILE_PARTS; source: DiffSource } | null {
  const href = /^!\[[^\]]*\]\(([^)]+)\)$/.exec(text)?.[1];
  const kind = href ? fileKind(href) : null;
  if (!href || !kind || !FILE_PARTS[kind].ownParagraph) return null;
  const target = imageTarget(href, task, root, sourceFile, report, files);
  if (target && "kind" in target) return target.kind === "task" ? { kind, source: { owner: target.id, path: target.path, known: target.id === task?.id,
    file: target.file ?? (target.id === task?.id ? task.files.find(file => file.name === target.path) : undefined) } } : null;
  const embed = !target && task ? reportEmbed(href) : null;
  return embed && task ? { kind, source: { owner: task.id, path: embed.path, known: true } } : null;
}

/**
 * The screen's own small Markdown,
 * written as React elements rather than HTML:
 * - `#` to `###` headings as h3 and `####` as h4, `- ` lists, `>` quotes (QUOTE);
 * - pipe tables without a header row (separator rows are dropped);
 * - fenced code with a copy mark in its top right corner (an unclosed fence stays ordinary code until closed); a
 *   closed ```diff or ```patch fence paints its rows once its colours come (DiffBlock);
 * - HTML as GitHub draws it, only its permitted tags and attributes (markdown-html), a block of it or tags in a line;
 *   its links and images found as the Markdown ones are, a `#heading` link scrolling to that heading;
 * - inline `**bold**`, `` `code` `` and task IDs as buttons
 *   that show the task's card, whose Open follows it (`onFollow`);
 * - local paths (links, code, bare absolute paths) through `localTarget`, judged as file links in domain/file-references.ts (which the Files tab reads too);
 * - web addresses (links and bare `https://…`) through `webTarget`: another origin's open in a new tab, this
 *   screen's in the same tab (its tasks and files as references).
 * Every Markdown the app shows goes through it. Text written outside a task (the coordinator's answers)
 * has no `task`: it resolves explicitly published files through its owning conversation.
 */
export { parseMarkdown } from "@/domain/markdown";
/**
 * Each tag's look and its space above, in one place. A block keeps only a top margin, so the
 * gap between two blocks is always the lower one's. A heading stands far from what is above it and
 * near what it heads, so a section reads as one group: in the heading's and the block's own lines (styles.css, Text
 * spacing) a line above a heading, a quarter line under it to its text, half a line between two headings and
 * between blocks, a quarter line between a list's items. Lines are the step's (14px on 22px, a 57% gap, in JLREQ's
 * 50–100% for Japanese); inline code is text-sm (a monospace face reads larger at one size; in a table it is the cells' own step); text lines stop
 * at the prose measure (components/ui/prose.ts).
 * An image and its caption are one figure in the code block's frame: in light the line parts a white
 * screenshot from the panel, in dark the ground does.
 * The time note (`note`) is the same in small.
 */
const BULLETS = ["list-disc", "list-[circle]", "list-[square]"];
const FLOW = {
  page: {
    root: "text-base",
    heading: (level: number) => level < 4 ? `${PROSE_MEASURE} text-md font-semibold` : `${PROSE_MEASURE} text-base font-semibold`,
    headingSpace: "mt-type-section",
    afterHeading: "mt-type-close",
    block: "mt-type-block",
    prose: PROSE_MEASURE,
    list: "pl-5 [&>li+li]:mt-type-close",
    table: "text-sm",
    code: "",
    codeFrame: "",
    caption: "mt-type-close text-xs text-muted",
    figure: "w-fit max-w-full rounded-sm border border-line bg-bg p-2",
    inlineFigure: "my-2 inline-flex max-w-full flex-col align-middle",
    imageButton: "block w-fit max-w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-muted",
    image: "block h-auto max-h-[60vh] max-w-full object-contain object-left",
    diagram: "block h-auto max-h-[60vh] max-w-full object-contain object-left",
    video: "block max-h-[60vh] max-w-full object-contain object-left",
    audio: "min-w-64",
  },
  note: {
    root: "text-ink",
    heading: () => "font-semibold",
    headingSpace: "mt-type-section",
    afterHeading: "mt-type-close",
    block: "mt-type-block",
    prose: "",
    list: "pl-5 [&>li+li]:mt-type-close",
    table: "text-sm",
    code: "text-sm",
    codeFrame: "p-2",
    caption: "mt-type-close text-xs text-muted",
    figure: "",
    inlineFigure: "my-1.5 inline-flex max-w-full flex-col align-middle",
    imageButton: "block w-full min-w-0 cursor-zoom-in focus-visible:outline-2 focus-visible:outline-muted",
    image: "block h-auto max-h-40 max-w-full rounded-sm border border-line object-contain object-left",
    diagram: "block h-auto max-h-80 max-w-full object-contain object-left",
    video: "max-h-40 max-w-full rounded-sm border border-line",
    audio: "min-w-56",
  },
};

/**
 * A word with no place to fold (a path or a call in code, an address) folds at any letter where it would outrun its
 * line, in every place the body is shown, a popover's too: the body owns this itself, whatever frame it is in,
 * and a word that fits keeps its normal folds.
 */
const FOLD = "[overflow-wrap:anywhere]";

/**
 * A quote is words set apart, not a state or a warning: its line is the reader's own edge grey (lit-line), so it takes
 * none of the colours that name a state (turn, working, done, stopped, error, changed).
 */
const QUOTE = "border-l-2 border-lit-line py-1 pl-3 text-sm";

/** A cell's words as they read (the line's one tree, inlineNodes): its marks and tags left out, a link's and an image's label kept. */
const cellWords = (cell: string) => nodeWords(inlineNodes(cell, { markdown: true }));

export function MarkdownBody({ text, task, onFollow, underTitle = false, sourceFile, report = false, variant, gallery, galleryReportKey, files }: {
  text: string; task: MarkdownTask | null; onFollow: (id: string) => void;
  /** Shown under the task's title (the reader's header): a first heading that only repeats the title is left out. */
  underTitle?: boolean; sourceFile?: string; report?: boolean; variant?: "note"; gallery?: GalleryImage[]; galleryReportKey?: string; files?: MarkdownFile[];
}) {
  const { t } = useTranslation("reader");
  const root = useWorkspaceInfo(info => info.root);
  const maxBytes = useAttachmentBytes();
  const { open: openViewer, viewer } = useImageViewer();
  const openUrl = useOpenUrlImage();
  const document = useMemo(() => markdownDocument(text), [text]);
  const key = galleryReportKey ?? "body";
  const images = useMemo(() => {
    if (gallery) return gallery;
    const slides: SliderImage[] = [];
    for (const medium of document.media) {
      const id = markdownMediumId(key, medium);
      if (medium.kind !== "file") {
        slides.push({ id, path: "", src: "", source: medium.source, alt: fenceLabel(t, medium) });
        continue;
      }
      const target = imageTarget(medium.path, task, root, sourceFile, report, files);
      if (!target || ("kind" in target && target.kind === "outside")) continue;
      const file = "kind" in target ? target.file : target;
      const name = file?.name ?? target.path;
      if (!isMedia(name)) continue;
      const revision = file && "revision" in file ? file.revision : undefined;
      const src = "kind" in target ? taskFileUrl(target.id, target.path, revision) : target.src;
      if (!src) continue;
      slides.push({ id, path: name, src, alt: medium.alt, showable: file ? showable(file, maxBytes) : true });
    }
    return slides;
  }, [gallery, document, key, task, root, sourceFile, report, files, maxBytes, t]);
  const open = (from: HTMLElement | null, id: string) => {
    const active = images.findIndex(image => image.id === id);
    if (active < 0) return;
    pauseTaskMedia();
    if (gallery && from?.closest("[data-report-feed]")) openUrl(from, id);
    else openViewer(from, images, active);
  };
  const inline = (value: InlineContent, mediaBlockSpace?: string, html?: { inners: Inners }) => <InlineMarkdown content={value} html={html} mediaKey={key} galleryReportKey={galleryReportKey} task={task} onFollow={onFollow} sourceFile={sourceFile} report={report} variant={variant} files={files} mediaBlockSpace={mediaBlockSpace} />;
  // A list under an item stands under the item's text, its bullets in the next shape (disc, circle, square) as GitHub draws them.
  const list = (block: List<InlineContent>, className: string, depth = 0): ReactNode => {
    const Tag = block.ordered ? "ol" : "ul";
    return <Tag start={block.ordered ? block.start : undefined} className={cn(className, flow.list, block.ordered ? "list-decimal" : BULLETS[Math.min(depth, 2)])}>
      {block.items.map((item, j) => <li key={j}>
        {inline(item.text)}
        {item.children.map((child, k) => child.type === "p"
          ? <p key={k} className="mt-type-close">{inline(child.text)}</p>
          : <Fragment key={k}>{list(child, "mt-type-close", depth + 1)}</Fragment>)}
      </li>)}
    </Tag>;
  };
  const blocks = document.blocks;
  const first = blocks[0];
  const shown = underTitle && first?.type === "heading" && first.text.text.trim() === task?.title.trim() ? blocks.slice(1) : blocks;
  const flow = FLOW[variant ?? "page"];
  // Each heading's anchor as GitHub names it, a repeated one numbered, for `#…` links to scroll to.
  const anchors = new Map<number, string>();
  const seen = new Map<string, number>();
  shown.forEach((block, i) => {
    if (block.type !== "heading") return;
    const base = headingAnchor(cellWords(block.text.text)), count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.set(i, count ? `${base}-${count}` : base);
  });
  const paragraphs = shown.map(block => block.type === "p" ? ownParagraphSource(block.text.text, task, root, sourceFile, report, files) : null);
  const spaceOf = (i: number) => {
    const underHeading = shown[i - 1]?.type === "heading";
    return shown[i]!.type === "heading" ? (underHeading ? flow.block : flow.headingSpace) : underHeading ? flow.afterHeading : flow.block;
  };
  // A code block the piece under it stands for (FILE_PARTS' standsFor: the git commands of the diffs under it), by index.
  const standing = shown.map((block, i) => {
    const next = paragraphs[i + 1];
    return block.type === "code" && block.closed && next ? FILE_PARTS[next.kind].standsFor?.(block.text) ?? null : null;
  });
  return (
    <MarkdownGallery.Provider value={{ open }}><div data-markdown-body="" data-report-variant={variant} className={cn(flow.root, FOLD, "[&>:first-child]:mt-0")}>
      {nest(shown.flatMap((block, i) => block.type === "html"
        // An HTML block in pieces where it closes a fold an earlier one left open: one piece inside, the next outside.
        ? htmlPieces(block.text).map((piece, j) => ({ closes: piece.closes, opens: piece.opens, draw: (inners: Inners = []) =>
          !piece.text.replace(/<!--[\s\S]*?-->/g, "").trim() ? null
          : <div key={`${i}.${j}`} data-markdown-html="" className={spaceOf(i)}>{inline({ text: piece.text, media: [] }, undefined, { inners })}</div> }))
        : [{ closes: 0, opens: 0, draw: () => {
        // A code block written under a list item stands where the item's text does (the list's own indent).
        const space = cn(spaceOf(i), block.type === "code" && block.nested && "ml-5");
        // Files of one kind written one after another are one piece, drawn where the first is (where the code block it
        // stands for is, when it stands for one).
        const own = paragraphs[i];
        if (own) {
          if (paragraphs[i - 1]?.kind === own.kind) return null;
          const group: DiffSource[] = [];
          for (let j = i; paragraphs[j]?.kind === own.kind; j++) group.push(paragraphs[j]!.source);
          return <Fragment key={i}>{FILE_PARTS[own.kind].ownParagraph!(group, { space: standing[i - 1] ? spaceOf(i - 1) : space, standing: standing[i - 1] ?? [] })}</Fragment>;
        }
        if (standing[i]) return null;
        switch (block.type) {
          case "heading": {
            const Heading = block.level < 4 ? "h3" : "h4";
            return <Heading key={i} data-anchor={anchors.get(i)} className={cn(space, flow.heading(block.level))}>{inline(block.text)}</Heading>;
          }
          case "p":
            if (/^!\[([^\]]*)\]\(([^)]+)\)$/.test(block.text.text)) return <Fragment key={i}>{inline(block.text, space)}</Fragment>;
            return (
              <p key={i} className={cn(space, flow.prose)}>
                {inline(block.text)}
              </p>
            );
          case "quote":
            return (
              <blockquote key={i} className={cn(space, QUOTE)}>
                {block.paragraphs.map((paragraph, j) => <p key={j} className={j > 0 ? flow.block : undefined}>{inline(paragraph)}</p>)}
              </blockquote>
            );
          case "list":
            return <Fragment key={i}>{list(block, cn(space, flow.prose))}</Fragment>;
          case "rule":
            return <hr key={i} className={cn(space, flow.prose, "border-0 border-t border-line")} />;
          case "table":
            return <TableFrame key={i} className={space}>
              <table className={cn("w-auto border-collapse", flow.table)}>
                <tbody>
                  {block.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => (
                        <td key={k} data-fit={cellWords(cell.text)} className={cn("border border-line px-2 py-1 text-left align-top font-normal", CELL_FLOOR)}>
                          {inline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>;
          case "code": {
            // A frame's look is the place's; a figure's space is its own.
            const frame = (at?: string) => ({ className: cn(at, flow.codeFrame, flow.code), codeClassName: flow.code });
            const plain = (at?: string) => <CodeBlock text={block.text} {...frame(at)} />;
            // Only a closed fence is drawn as its kind: one still being written stays ordinary code until it closes.
            const kind = block.closed ? fenceKind(block.language) : null;
            if (!kind) return <Fragment key={i}>{plain(space)}</Fragment>;
            return <Fragment key={i}>{FENCE_PARTS[kind].draw({ text: block.text, medium: block.medium, space, frame, plain,
              figureClassName: flow.diagram, captionClassName: flow.caption, galleryReportKey,
              mediumId: medium => markdownMediumId(key, medium), open })}</Fragment>;
          }
        }
      } }]))}
    </div>{viewer}</MarkdownGallery.Provider>
  );
}

/**
 * The blocks as drawn, those under an HTML piece that leaves folds or sections open (`opens`) drawn inside the
 * innermost one still open, each closing tag before a later piece (`closes`) stepping out of one.
 */
function nest(pieces: { closes: number; opens: number; draw: (inners?: Inners) => ReactNode }[]): ReactNode[] {
  const out: ReactNode[] = [];
  const frames: { draw: (inners: Inners) => ReactNode; inners: Inners; level: number; key: number }[] = [];
  const add = (node: ReactNode, key: number) => {
    const frame = frames.at(-1);
    (frame ? frame.inners[frame.level - 1]! : out).push(<Fragment key={key}>{node}</Fragment>);
  };
  const close = () => { const frame = frames.pop()!; add(frame.draw(frame.inners), frame.key); };
  pieces.forEach(({ closes, opens, draw }, key) => {
    for (; closes > 0 && frames.length; closes--) if (--frames.at(-1)!.level === 0) close();
    if (opens) frames.push({ draw, inners: Array.from({ length: opens }, () => []), level: opens, key });
    else add(draw(), key);
  });
  while (frames.length) close();
  return out;
}

function MarkdownMedia({ file, alt, inline = false, variant, space, mediaId, galleryReportKey }: {
  file: MarkdownFile; alt: string; inline?: boolean; variant?: "note"; space?: string; mediaId?: string; galleryReportKey?: string;
}) {
  const { t } = useTranslation("reader");
  const [broken, setBroken] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const gallery = useContext(MarkdownGallery);
  const maxBytes = useAttachmentBytes();
  const flow = FLOW[variant ?? "page"];
  const { path, src, href } = file;
  const kind = mediaKind(file.name);
  if (!src || !kind || !showable(file, maxBytes) || broken) {
    // A file this browser could not show or play leads to its own bytes; a missing or unreadable one to its folder.
    const content = <>{mediaUnavailable(t, kind, alt || path)}{" "}
      {broken && src ? <FileLinkAnchor link={savedFileLink(src)} /> : href && <a href={href}>{t("image.openFile")}</a>}</>;
    return inline ? <span className="text-sm text-muted">{content}</span> : <Message size="line" tone="info" icon="image" className={space} title={content} />;
  }
  const open = () => { if (mediaId) gallery?.open(trigger.current, mediaId); };
  const triggerProps = { "data-report-image-trigger": "", "data-report-key": galleryReportKey,
    "data-image-path": path, "data-image-alt": alt, "data-media-id": mediaId };
  const preview = kind === "audio"
    ? <TaskAudio src={src} label={alt || path} onError={() => setBroken(true)} className={flow.audio} />
    : kind === "video"
    ? variant === "note"
      ? <button ref={trigger} type="button" onClick={open} {...triggerProps} className="block max-w-full cursor-zoom-in">
          <VideoPoster src={src} onError={() => setBroken(true)} className={flow.video} />
        </button>
      : <span className="relative block w-fit max-w-full">
          <TaskVideo src={src} aria-label={alt || path} onError={() => setBroken(true)} className={flow.video} />
          <ExpandVideo buttonRef={trigger} onClick={open} triggerProps={triggerProps} />
        </span>
    : <button ref={trigger} type="button" className={flow.imageButton} {...triggerProps} onClick={open}>
        <img src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} className={flow.image} />
      </button>;
  return <>
    {inline ? <span className={cn(flow.inlineFigure, flow.figure)}>{preview}
      {alt && <span className="mt-1 text-xs text-muted">{alt}</span>}</span>
      : <figure className={cn(space, flow.figure)}>{preview}{alt && <figcaption className={flow.caption}>{alt}</figcaption>}</figure>}
  </>;
}

/** Task references keep Task ownership; loading another task's metadata uses the same resources as ReportBody. */
function TaskMarkdownMedia({ owner, path, knownFile, known, ...props }: {
  owner: string; path: string; knownFile?: TaskDetail["files"][number]; known: boolean;
  alt: string; inline?: boolean; variant?: "note"; space?: string; mediaId?: string; galleryReportKey?: string;
}) {
  const root = useWorkspaceInfo(info => info.root);
  const query = useQuery({ ...resources.taskView(root, owner), enabled: !known });
  const file = known ? knownFile : query.data?.task.files?.find(file => file.name === path);
  return <MarkdownMedia key={file?.revision ?? "unavailable"} {...props} file={{ path, name: file?.name ?? path, size: file?.size ?? 0,
    readable: file?.readable, src: file ? taskFileUrl(owner, path, file.revision) : null,
    href: taskFilesLink(owner, file ? path : "") }} />;
}

// Exactly two slash-separated IDs are two references; a longer route is a path.
const TASK_ID = new RegExp(
  `(?<![\\w/.-])(${TASK_ID_PATTERN}(?:/${TASK_ID_PATTERN})?)(?![\\w/]|\\.[\\w])`, "g",
);

/**
 * Prose references and explicit task links both name a task by its own ID. Local paths (in a link, in
 * code, or bare) go through `localTarget`: a Task-folder path opens as it opens (fileOpening: a file in the viewer), any other place
 * shows its whole path with a copy button. Other code stays literal.
 */
function InlineMarkdown({ content, html: block, task, onFollow, sourceFile, report, variant, galleryReportKey, files, mediaBlockSpace, mediaKey }: {
  /** Set for an HTML block: its words are not read as Markdown; `inners` go in the folds or sections it leaves open. */
  content: InlineContent; html?: { inners: Inners }; task: MarkdownTask | null; onFollow: (id: string) => void; sourceFile: string | undefined; report: boolean; variant: "note" | undefined; galleryReportKey: string | undefined; files: MarkdownFile[] | undefined; mediaBlockSpace: string | undefined; mediaKey: string;
}) {
  const { t } = useTranslation("reader");
  // A text may name a task outside the project in view; opening it widens the list to every project.
  const index = useEveryTaskIndex();
  const { root } = useWorkspaceInfo();
  const view = useSurfaceDocument().defaultView ?? window;
  // The places the task's words may name code files in (its projects' code locations and their worktrees): a path in
  // one opens in the viewer; the server judges the file again where it really is.
  const absolute = /(?:^|[\s(\[`"'])(?:\/|file:\/\/)[^\s/]/.test(content.text);
  const codeRoots = useQuery({ ...resources.codeRoots(root, task?.id ?? ""), enabled: !!task && absolute }).data?.roots ?? [];
  // The screen's own window: the coordinator's window shows the same screen's words.
  const origin = location.origin;
  const reference = (id: string, label: ReactNode = id) => {
    const target = resolveReference(id, index);
    return target ? <TaskReference id={target.id} label={label} onFollow={onFollow} /> : label;
  };
  // An address of another origin opens in a new tab, shown as written (folding as the body folds). One of this origin
  // stays in this tab: a known task or its file as the reference to it, a state of the screen as a history step.
  const web = (href: string, label: ReactNode): ReactNode => {
    const target = webTarget(href, origin);
    if (target.kind === "away") return <a href={href} target="_blank" rel="noreferrer noopener">{label ?? href}</a>;
    const managed = addressTarget(href, { task, root, origin });
    if (managed) return place(managed, label);
    const found = target.task && taskAtAddress(target.task.address, index);
    if (found) return <TaskReference id={found.id} label={label ?? found.id} onFollow={onFollow} />;
    return <a href={href} onClick={target.screen ? (event) => {
      if (!plainPress(event)) return;
      event.preventDefault();
      openScreenLink(href);
    } : undefined}>{label ?? href}</a>;
  };
  const place = (target: LocalTarget, label: ReactNode, image = false, mediaId?: string): ReactNode => {
    // The place flows with the sentence: the path folds at any letter but keeps its copy beside its last one, and
    // on a phone the copy's 44px press reaches past its 20px mark instead of making its line taller.
    if (target.kind === "outside") {
      const copy = <CapCentred className="ms-0.5"><Button variant="quiet" size="icon" className="relative min-h-5 w-5 narrow:min-h-5 narrow:w-5 narrow:after:absolute narrow:after:-inset-3 narrow:after:content-['']" aria-label={`${t("files.copyPath")}: ${target.path}`} title={target.path}
        onClick={() => void writeClip(textClip(target.path), { view })}><Icon name="copy" className="size-3" /></Button></CapCentred>;
      // A file in the task's code places opens in the viewer; any other place is its path to copy.
      const opens = !!task && !target.path.endsWith("/") && codeRoots.some(top => target.path.startsWith(top.endsWith("/") ? top : `${top}/`));
      const press = (inner: ReactNode, named: boolean) => opens ? <button type="button" onClick={() => openView(task!.id, target.path)}
        {...named ? { "data-code-path": target.path, "aria-label": target.path } : { tabIndex: -1, "aria-hidden": true }}
        className="inline cursor-pointer text-left [color:inherit] underline decoration-1 underline-offset-2">{inner}</button> : inner;
      // A path folds only after a "/", its file's name kept whole with its copy mark; a label folds as words do.
      const at = label ? -1 : target.path.lastIndexOf("/");
      const folders = target.path.slice(0, at + 1).split("/").slice(0, -1).flatMap((part, i) => [`${part}/`, <wbr key={i} />]);
      const text = <>{folders.length > 0 && press(folders, false)}<span className={cn(!label && "whitespace-nowrap")}>{press(label || target.path.slice(at + 1), true)}{copy}</span></>;
      return label ? <span title={target.path}>{text}</span>
        : <code title={target.path} className={cn("font-[monospace] text-sm [overflow-wrap:anywhere]", !opens && "text-muted")}>{text}</code>;
    }
    const { id: owner, path, file } = target;
    // A file drawn as a link in a sentence (FILE_PARTS: a diff) is its file's link; any other image reference is media.
    const kind = fileKind(path);
    if (image && !(kind && FILE_PARTS[kind].inSentence === "link")) return <TaskMarkdownMedia owner={owner} path={path} knownFile={file} known={owner === task?.id}
      alt={typeof label === "string" ? label : ""} inline={mediaBlockSpace === undefined} space={mediaBlockSpace} variant={variant} mediaId={mediaId} galleryReportKey={galleryReportKey} />;
    const name = label || (path.endsWith("/") ? path : path.split("/").at(-1));
    // Keep the native inline hit box: a font's glyph box need not be 1em tall. Padding derived from
    // that assumption can reach into the next line on macOS and steal its link's press.
    return <a href={taskFilesLink(owner, path)} title={path}
      onClick={(event) => {
        if (!plainPress(event)) return;
        event.preventDefault();
        useViewStore.getState().openTaskFile(owner, path);
      }}>{name}</a>;
  };
  // Words outside code read their character references (&amp;, &middot;) as GitHub does.
  const references = (value: string) => split(value, TASK_ID, (written) => {
    const ids = written.split("/");
    return ids.length === 2 ? <>{reference(ids[0]!)}/{reference(ids[1]!)}</> : reference(written);
  }, decodeEntities);
  /** Where a written link leads, a Markdown one or an HTML one alike; `label` empty shows the address's own name. */
  const linkTo = (href: string, label: ReactNode): ReactNode => {
    const published = files?.find(file => file.path === href);
    if (published?.removed) return <Removed name={typeof label === "string" && label ? label : published.name} path={href} />;
    if (published) return published.href ? <a href={published.href} target="_blank" rel="noreferrer noopener">{label || published.name}</a>
        : <span className="text-muted" title={href}>{t("files.unavailable", { name: typeof label === "string" && label ? label : published.name })}</span>;
    // A heading of the same text: scrolled to in place, the screen's own address kept.
    if (href.startsWith("#")) return <a href={href} onClick={event => {
      if (!plainPress(event)) return;
      event.preventDefault();
      const name = headingAnchor(safeDecode(href.slice(1)));
      event.currentTarget.closest("[data-markdown-body]")?.querySelector(`[data-anchor="${CSS.escape(name)}"]`)?.scrollIntoView({ block: "start" });
    }}>{label || href}</a>;
    const target = fileTarget(href, task, root, sourceFile);
    if (target) return place(target, label || null);
    // Only HTTP(S) and mail addresses open outside.
    if (/^https?:\/\//i.test(href)) return web(href, label || null);
    if (/^mailto:/i.test(href)) return <a href={href}>{label || href.slice(7)}</a>;
    return reference(href, label);
  };
  /** An HTML image's address, found as Markdown's image is: a Task's or a published file. A web image is not fetched
   * (no request leaves the screen for what a text names), so its words show instead. */
  const imageSrc = (src: string): string | null => {
    const target = imageTarget(src, task, root, sourceFile, report, files);
    if (target && "kind" in target) return target.kind === "task"
      ? taskFileUrl(target.id, target.path, target.file && "revision" in target.file ? target.file.revision : undefined) : null;
    return target?.src ?? null;
  };
  const paths = (value: string) => split(value, BARE_PATH, (path) => {
    const target = pathTarget(path, { task, root, origin });
    return target ? place(target, null) : path;
  }, references);
  const urls = (value: string) => split(value, bareUrls, (href) => web(href, null), paths);
  /** A Markdown link or image, `label` its drawn words (HTML in it included). */
  const link = (node: Extract<InlineNode, { kind: "link" }>, label: ReactNode) => {
    const { image, href } = node;
    const medium = content.media.find(item => item.at === node.at)?.medium;
    const mediaId = medium && markdownMediumId(mediaKey, medium);
    if (image) {
      const target = imageTarget(href, task, root, sourceFile, report, files);
      if (!target) return <span>{node.label}</span>;
      if (!("kind" in target) && target.removed) return <Removed name={node.label || target.name} path={href} />;
      return "kind" in target ? place(target, node.label, true, mediaId)
        : <MarkdownMedia file={target} alt={node.label} inline={mediaBlockSpace === undefined} space={mediaBlockSpace}
          variant={variant} mediaId={mediaId} galleryReportKey={galleryReportKey} />;
    }
    return linkTo(href, label);
  };
  const code = (inner: string) => {
    const target = codeTarget(inner, { task, root, sourceFile, origin });
    return target ? place(target, null) : <code className="font-[monospace] text-sm">{inner}</code>;
  };
  /**
   * The line's one tree (inlineNodes), drawn: HTML's elements with only their permitted attributes. Words go through
   * `urls` (addresses, paths, task IDs), a link's and code's as written, an HTML block's as written too. `inners`: the
   * blocks for the folds or sections an HTML block leaves open, outermost first.
   */
  const draw = (tree: InlineNode[], { plain, inners = [] }: { plain: boolean; inners?: Inners }): ReactNode[] => {
    const open: InlineNode[] = [];
    const find = (nodes: InlineNode[]) => nodes.forEach(node => {
      if (node.kind !== "element") return;
      if (node.open && CONTAINERS.has(node.tag)) open.push(node);
      find(node.children);
    });
    find(tree);
    // What each node links to, how its words read and whether its children are drawn is nodeReading's: the Files tab
    // reads the Deliverables field's links by the same (file-references.ts). Here only the drawing.
    const nodes = (list: InlineNode[], parent: string, reading: Reading): ReactNode[] => list.map((node, key) => {
      const { link: address, words, children: under } = nodeReading(node, reading);
      const inner = (tag: string) => under && "children" in node ? nodes(node.children, tag, under) : [];
      switch (node.kind) {
        case "text": return TABLE_PARTS.has(parent) && !node.text.trim() ? null
          : <Fragment key={key}>{words === "addresses" ? urls(node.text) : decodeEntities(node.text)}</Fragment>;
        case "code": return <Fragment key={key}>{code(node.text)}</Fragment>;
        case "strong": return <strong key={key}>{inner("strong")}</strong>;
        // No link inside a link: an inner one is its words. An image's words are its label.
        case "link": {
          const label = inner("a");
          return <Fragment key={key}>{address === null ? label : link(node, label.length ? <>{label}</> : null)}</Fragment>;
        }
      }
      const { attrs, tag } = node;
      const children = inner(tag);
      if (tag === "a") return <Fragment key={key}>{address ? linkTo(address, children.length ? <>{children}</> : null) : children}</Fragment>;
      if (tag === "img") return <HtmlImage key={key} src={attrs.src ? imageSrc(attrs.src) : null} alt={attrs.alt ?? ""} width={attrs.width} height={attrs.height} align={attrs.align} title={attrs.title} />;
      if (tag === "picture") return <Fragment key={key}>{children}</Fragment>;
      const at = open.indexOf(node);
      const inside = tag === "table" ? wrapRows(node.children, children) : at >= 0 ? [...children, <Fragment key="inner">{inners[at]}</Fragment>] : children;
      // An HTML heading takes its anchor as a Markdown one does.
      const anchor = /^h[1-6]$/.test(tag) ? { "data-anchor": headingAnchor(nodeWords(node.children)) } : {};
      const element = createElement(tag, { key, ...htmlProps(attrs), ...anchor, className: HTML_LOOK[tag] }, ...(VOID_TAGS.has(tag) ? [] : inside));
      return tag === "table" ? <TableFrame key={key}>{element}</TableFrame> : element;
    });
    return nodes(tree, "", { asWritten: plain, inLink: false });
  };
  if (block) return <>{draw(htmlNodes(content.text), { plain: true, inners: block.inners })}</>;
  return <>{draw(inlineNodes(content.text, { markdown: true }), { plain: false })}</>;
}

const safeDecode = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };

/** Parts of a table where the line breaks between its tags are no words. */
const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr", "colgroup"]);
function wrapRows(nodes: InlineNode[], drawn: ReactNode[]): ReactNode[] {
  // A table's rows written straight under it are its body's, its columns its column group's, as the browser reads them.
  const out: ReactNode[] = [];
  let group: { tag: "tbody" | "colgroup"; items: ReactNode[] } | null = null;
  const flush = (key: number) => { if (group) out.push(createElement(group.tag, { key: `g${key}` }, ...group.items)); group = null; };
  nodes.forEach((node, i) => {
    const tag = node.kind === "element" && node.tag === "tr" ? "tbody" : node.kind === "element" && node.tag === "col" ? "colgroup" : null;
    if (tag && group?.tag !== tag) flush(i);
    if (tag) (group ??= { tag, items: [] }).items.push(drawn[i]);
    else { flush(i); out.push(drawn[i]); }
  });
  flush(nodes.length);
  return out;
}

/** The permitted attributes as React writes them. */
function htmlProps(attrs: Record<string, string>): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "colspan") props.colSpan = Number(value);
    else if (name === "rowspan") props.rowSpan = Number(value);
    else if (name === "valign") props.vAlign = value;
    else if (name === "open") props.open = true;
    else if (name === "start" || name === "span") props[name] = Number(value);
    else props[name] = value;
  }
  return props;
}

/** What the page's reset takes from a tag, given back as a README reads (a list's marks, a table's lines, a heading's size). */
const HTML_LOOK: Record<string, string> = {
  h1: "mt-type-section text-xl font-semibold first:mt-0", h2: "mt-type-section text-lg font-semibold first:mt-0",
  h3: "mt-type-section text-md font-semibold first:mt-0", h4: "mt-type-section font-semibold first:mt-0",
  h5: "mt-type-section font-semibold first:mt-0", h6: "mt-type-section font-semibold first:mt-0",
  p: "mt-type-block first:mt-0", ul: "mt-type-block list-disc pl-5 first:mt-0", ol: "mt-type-block list-decimal pl-5 first:mt-0",
  blockquote: cn("mt-type-block first:mt-0", QUOTE), details: "mt-type-block first:mt-0", summary: "cursor-pointer",
  pre: "mt-type-block overflow-x-auto font-[monospace] text-sm whitespace-pre first:mt-0",
  code: "font-[monospace] text-sm", tt: "font-[monospace] text-sm", samp: "font-[monospace] text-sm",
  kbd: "rounded-sm border border-line px-1 font-[monospace] text-sm", u: "underline", hr: "my-3 border-line",
  table: "w-auto border-collapse text-sm", th: "border border-line px-2 py-1 font-semibold", td: "border border-line px-2 py-1",
  dt: "font-semibold", dd: "pl-5",
};

/** An HTML image as GitHub draws it, in the line; its words (alt) where it cannot be shown. */
function HtmlImage({ src, alt, width, height, align, title }: { src: string | null; alt: string; width?: string; height?: string; align?: string; title?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return alt ? <span className="text-sm text-muted">{alt}</span> : null;
  return <img src={src} alt={alt} title={title} width={width} height={height} {...{ align }} loading="lazy"
    onError={() => setBroken(true)} className="inline max-w-full align-middle" />;
}

/** A task reference shows the shared task card and follows the reference as useTaskCardOn says. */
function TaskReference({ id, label, onFollow }: { id: string; label: ReactNode; onFollow: (id: string) => void }) {
  const root = useWorkspaceInfo((info) => info.root);
  const prefetch = usePrefetch(id);
  const { anchor, trigger, card } = useTaskCardOn<HTMLButtonElement>(id, (from) => {
    if (from) followReference(from, id, () => onFollow(id));
    else onFollow(id);
  });
  return <><Button ref={anchor} variant="ref" data-task-reference={id} {...prefetch}
    {...trigger}>{label}</Button>{card}</>;
}

/**
 * Cut `text` at each match of `pattern` (global, one capture group) or each piece `pattern` finds: matches
 * go through `match`, the text between them through `rest` (as is by default).
 * Each piece is keyed by where it starts, so nested pieces never share a key.
 */
function split(
  text: string,
  pattern: RegExp | ((text: string) => FoundUrl[]),
  match: (captured: string, at: number) => ReactNode,
  rest: (between: string, at: number) => ReactNode = (between) => between,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  const between = (end: number) => {
    if (end > last) nodes.push(<Fragment key={`t${last}`}>{rest(text.slice(last, end), last)}</Fragment>);
  };
  const pieces = typeof pattern === "function" ? pattern(text)
    : Array.from(text.matchAll(pattern), found => ({ index: found.index, length: found[0].length, captured: (found[1] ?? found[2])! }));
  for (const found of pieces) {
    between(found.index);
    nodes.push(<Fragment key={`m${found.index}`}>{match(found.captured, found.index)}</Fragment>);
    last = found.index + found.length;
  }
  between(text.length);
  return nodes;
}

/** A published file cleaned away: its name, said to be removed, in the words' place. */
function Removed({ name, path }: { name: string; path: string }) {
  const { t } = useTranslation("reader");
  return <span data-file-removed className="text-muted" title={path}>{t("files.removed", { name })}</span>;
}
