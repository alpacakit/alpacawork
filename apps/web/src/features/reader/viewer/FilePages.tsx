import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ReadFailure } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useWorkspaceInfo } from "@/data/queries";
import { FILE_READ_BYTES, resources } from "@/data/resources";
import { cn } from "@/lib/utils";
import { savedFileLink, taskFileUrl, type FileLink } from "@/data/task-file-url";
import { FileLinkAnchor } from "../FileLinkAnchor";
import { DELIMITED_MAX_BYTES, isDelimitedFile } from "@/domain/delimited-file";
import type { TaskFile } from "@/domain/task-files";
import { DelimitedFile } from "../files/DelimitedFile";
import { HtmlFrame, isHtml } from "../files/HtmlFrame";
import { MarkdownFile } from "../files/MarkdownFile";
import type { MarkdownTask } from "../MarkdownBody";
import { COLUMN } from "../reading-column";
import { useColoursSettled, useDiffColours } from "../diff/diff-colours";
import { LineRows, paint, type Line } from "./LineRows";
import type { ViewerDocument } from "./Viewer";

/**
 * How a file is read in the viewer, by its name: a document (`.md`) as it reads, a page (`.html`) as it is drawn, a
 * table (`.csv`, `.tsv`) as its cells; any other by its lines. Only a Task's file is drawn (its links, pictures and
 * bytes are its Task's); a code location's file is read by its lines.
 */
export function fileReading(path: string): "document" | "page" | "table" | "lines" {
  return /\.md$/i.test(path) ? "document" : isHtml(path) ? "page" : isDelimitedFile(path) ? "table" : "lines";
}

/**
 * The most of a file its drawing reads: a table's own limit (past it the table is not drawn and its bytes are not read),
 * the screen's for any other. The viewer asks for a file's words as it opens only within it; a larger one read by its
 * lines (LaterLines) holds its words then, and they are copied as any read ones are.
 */
export const drawnBytes = (reading: ReturnType<typeof fileReading>) => reading === "table" ? DELIMITED_MAX_BYTES : FILE_READ_BYTES;

/** A Task's file the viewer draws: the Task (what its links and pictures are of), the file, and where a task reference goes. */
export type DrawnFile = { task: MarkdownTask; file: TaskFile; onFollow: (id: string) => void };

/**
 * Whether a file's text is read before it is drawn: a page and a table are drawn from their own bytes (HtmlFrame,
 * DelimitedFile), so their text is read only when they are read by their lines.
 */
export const drawnFromText = (reading: ReturnType<typeof fileReading>) => reading === "lines" || reading === "document";

/**
 * A file read in the viewer (Viewer.tsx): one page. By its lines, numbered as a diff's are (LineRows), with nothing a
 * diff adds; its letters painted, as a diff's are, once its colours come (by its name's language; none, or over 2000
 * lines, plain). A Task's document, page or table (`drawn`) is drawn as it reads, and on a computer read by its lines
 * too, as a diff's document is (`looks.source`). `text` is null for a page or a table, whose text is read only then.
 * Being one page, it has no heading of its own: the viewer's title names it (viewerLayout).
 */
export function fileDocument(path: string, text: string | null, drawn?: DrawnFile): ViewerDocument {
  const reading = drawn ? fileReading(path) : "lines";
  const at = path.lastIndexOf("/");
  const byLines = text === null ? <LaterLines drawn={drawn!} /> : <FileLines path={path} text={text} />;
  return { kind: "pages", counts: null, lines: text === null ? 0 : linesOf(text).length, looks: { split: false, code: false, source: reading !== "lines" },
    pages: [{ key: path, path, place: path.slice(0, at + 1),
      name: line => <span data-page-name={path} className={cn("min-w-0 font-semibold", line ? "truncate" : "[overflow-wrap:anywhere]")}>{path.slice(at + 1)}</span>,
      body: look => reading === "lines" || look.source || !drawn ? byLines : <Drawn reading={reading} drawn={drawn} text={text ?? ""} /> }] };
}

/** A Task's document, page or table as it reads, in the viewer's room (a document in the reading column). */
function Drawn({ reading, drawn: { task, file, onFollow }, text }: { reading: "document" | "page" | "table"; drawn: DrawnFile; text: string }): ReactNode {
  if (reading === "document") return <div className="@container px-4 narrow:px-3"><div data-file-prose="" className={COLUMN.body}>
    <MarkdownFile text={text} task={task} sourceFile={file.name} onFollow={onFollow} /></div></div>;
  return <div className="px-4 narrow:px-3">{reading === "page" ? <HtmlFrame taskId={task.id} file={file} />
    : <DelimitedFile taskId={task.id} file={file} url={taskFileUrl(task.id, file.name, file.revision)} />}</div>;
}

/** A page's or a table's lines, its text read once they are asked for. */
function LaterLines({ drawn: { task, file } }: { drawn: DrawnFile }) {
  const { t } = useTranslation("reader");
  const root = useWorkspaceInfo(info => info.root);
  const text = useQuery(resources.fileText(root, task.id, file.name, file.revision));
  if (typeof text.data === "string") return <FileLines path={file.name} text={text.data} />;
  return <div className="px-4 narrow:px-3">{text.isError ? <ReadFailure what={t("viewer.cannotOpen")} error={text.error} retry={() => void text.refetch()} />
    : text.data === null ? <NotText link={savedFileLink(taskFileUrl(task.id, file.name, file.revision))} /> : <RegionSkeleton shape="text" />}</div>;
}

/** Why a file is not read here, its bytes being no text, with the file itself to open. */
export function NotText({ link }: { link: FileLink }) {
  const { t } = useTranslation("reader");
  return <Message tone="caution" icon="file" title={t("viewer.binary")}
    description={<FileLinkAnchor link={link} />} />;
}

/** A text's lines as read: a last newline ends the last line, starting no line of its own. */
function linesOf(text: string) {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.map(line => line.replace(/\r$/, ""));
}

function FileLines({ path, text }: { path: string; text: string }) {
  const letters = useMemo(() => linesOf(text), [text]);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const colours = useDiffColours(useMemo(() => ({ kind: "file", path, text }), [path, text]), frame, true);
  const shown = useColoursSettled(colours);
  const rows = useMemo(() => letters.map((line, at): Line => ({ kind: "line", id: `l${at + 1}`, numbers: [at + 1], phone: at + 1,
    text: colours?.[at] ? paint(line, colours[at], null, "", 0) : line })), [letters, colours]);
  return <LineRows frame={setFrame} rows={rows} signs={false} className={shown ? undefined : "invisible"} />;
}
