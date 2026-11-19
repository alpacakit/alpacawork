import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, HEAD_MARK, HEAD_MARK_GAP } from "@/components/ui/button";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { Switch } from "@/components/ui/switch";
import { FileReadLimitError } from "@/data/client";
import { resources } from "@/data/resources";
import { useWorkspaceInfo } from "@/data/queries";
import { DELIMITED_MAX_BYTES, DELIMITED_MAX_CELLS, DELIMITED_MAX_ROWS, DELIMITED_PAGE_ROWS, parseDelimited } from "@/domain/delimited-file";
import type { TaskFile } from "@/domain/task-files";
import { scrollMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CELL_FLOOR, TableFrame } from "../TableFrame";
import { WrapToggle } from "../WrapToggle";

/**
 * A CSV or TSV file as a table, read from its bytes. A file over the table's limit (DELIMITED_MAX_BYTES) is not asked
 * for, and one whose body outruns it is let go (FileReadLimitError): both are the original's link with the reason. Any
 * other failure is the reader's ReadFailure with its retry.
 */
export function DelimitedFile({ taskId, file, url }: { taskId: string; file: TaskFile; url: string }) {
  const { t } = useTranslation("reader");
  const root = useWorkspaceInfo(info => info.root);
  const fits = file.size <= DELIMITED_MAX_BYTES;
  const bytes = useQuery({ ...resources.fileBytes(root, taskId, file.name, file.revision), enabled: fits });
  // Its bytes are the file's one read (shared with its words), so a body past the table's limit is told here.
  if (!fits || bytes.error instanceof FileReadLimitError || bytes.data && bytes.data.length > DELIMITED_MAX_BYTES) return <Message tone="caution" icon="file"
    title={t("delimited.tooLarge", { limit: DELIMITED_MAX_BYTES / 1024 / 1024 })}
    description={<>{t("delimited.openOriginal")} <a href={url} target="_blank" rel="noopener noreferrer">{file.name}</a></>} />;
  if (bytes.isError) return <ReadFailure what={t("ruleTab.readFailed")} error={bytes.error} retry={() => void bytes.refetch()} />;
  if (bytes.data === undefined) return <RegionSkeleton shape="text" />;
  return <DelimitedTable bytes={bytes.data} name={file.name} url={url} />;
}

/**
 * The table and the reader's choices over it: whether the first record is the header, whether long cells fold, and which
 * page of DELIMITED_PAGE_ROWS records is shown. The encoding is the file's (parseDelimited), never the reader's to pick.
 * Each choice reads again only what is in hand; they last while the file is open (FilesTab keys it by name and
 * revision). Every cell is its text as read, a line break or a leading 0 kept; a record's number is its place among
 * the records (the header is 1), not a line of the file, and stays whatever is chosen.
 */
function DelimitedTable({ bytes, name, url }: { bytes: Uint8Array; name: string; url: string }) {
  const { t } = useTranslation("reader");
  const [header, setHeader] = useState(true);
  // Folded first: these files are mostly read for their words, and a whole long cell needs no sideways reading.
  const [wrapped, setWrapped] = useState(true);
  const [chosenPage, setPage] = useState(0);
  const top = useRef<HTMLElement>(null);
  const read = useMemo(() => parseDelimited(bytes, name), [bytes, name]);
  const rows = read.kind === "decoded" ? read.rows : [];
  const headed = header && rows.length > 0;
  const body = rows.length - (headed ? 1 : 0);
  const pages = Math.max(1, Math.ceil(body / DELIMITED_PAGE_ROWS));
  // A choice that leaves fewer pages keeps the reader on the last one there is.
  const page = Math.min(chosenPage, pages - 1);
  const first = (headed ? 1 : 0) + page * DELIMITED_PAGE_ROWS;
  const last = Math.min(rows.length, first + DELIMITED_PAGE_ROWS);
  const turn = (next: number) => {
    setPage(next);
    top.current?.scrollIntoView({ block: "start", behavior: scrollMotion() });
  };
  const original = <a href={url} target="_blank" rel="noopener noreferrer">{t("delimited.original")}</a>;

  return <section ref={top} data-delimited={wrapped ? "wrapped" : "whole"}
    className="flex min-w-0 flex-col gap-2 scroll-mt-3 narrow:scroll-mt-[calc(var(--reader-header-h,0px)+0.75rem)]">
    {/* One line over the table: how many records there are, then the block's own marks at its top end, as a diff has
        them: the header switch, then the fold, the reader head's copy mark in look and size (HEAD_MARK), as close as the
        reader head's marks (HEAD_MARK_GAP). The file itself is saved from the viewer's head. Only over a table: with none,
        there is nothing for them to change, and the notice links the original. */}
    {rows.length > 0 && <div data-delimited-head="" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
      <span className="tabular-nums whitespace-nowrap">{t("delimited.records", { count: rows.length })}</span>
      <span className={`ms-auto flex items-center ${HEAD_MARK_GAP}`}>
        <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-ink">
          {t("delimited.header")}<Switch checked={header} onCheckedChange={setHeader} />
        </label>
        <WrapToggle wrapped={wrapped} onWrap={setWrapped} className={HEAD_MARK} />
      </span>
    </div>}
    {read.kind === "encoding-error" ? <Notice title={t("delimited.unreadable")} description={<>{t("delimited.openOriginal")} {original}</>} />
      : !rows.length ? read.truncated ? <Notice title={t("delimited.tooWide", { maxCells: DELIMITED_MAX_CELLS })} description={<>{t("delimited.openOriginal")} {original}</>} />
        : <Message tone="empty" icon="file" title={t("delimited.empty")} />
      : <>
        {read.truncated && <Notice title={t("delimited.truncated", { rows: rows.length, maxRows: DELIMITED_MAX_ROWS, maxCells: DELIMITED_MAX_CELLS })}
          description={<>{t("delimited.rest")} {original}</>} />}
        {read.malformed && <Notice title={t("delimited.malformed")} description={t("delimited.malformedHint")} />}
        {read.uneven && <Notice title={t("delimited.uneven")} description={t("delimited.unevenHint")} />}
        <TableFrame>
          <table className="w-auto border-collapse text-sm">
            {headed && <thead><Row number={1} cells={rows[0]!} columns={read.columns} wrapped={wrapped} head /></thead>}
            <tbody>
              {rows.slice(first, last).map((cells, i) => <Row key={first + i} number={first + i + 1} cells={cells} columns={read.columns} wrapped={wrapped} />)}
            </tbody>
          </table>
        </TableFrame>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
          <span className="tabular-nums">{body ? t("delimited.range", { first: first + 1, last, rows: rows.length }) : t("delimited.headerOnly")}</span>
          {page > 0 && <Button variant="outline" className="min-h-control-xs px-2.5" onClick={() => turn(page - 1)}>
            {t("delimited.previous", { count: DELIMITED_PAGE_ROWS })}
          </Button>}
          {page < pages - 1 && <Button variant="outline" className="min-h-control-xs px-2.5" onClick={() => turn(page + 1)}>
            {t("delimited.next", { count: Math.min(DELIMITED_PAGE_ROWS, rows.length - last) })}
          </Button>}
          <span className="ms-auto">{original}</span>
        </div>
      </>}
  </section>;
}

/** What the reader should know about the table before reading it: a caution line, said as the file is read. */
function Notice({ title, description }: { title: string; description: ReactNode }) {
  return <Message tone="caution" size="line" live title={title} description={description} />;
}

/**
 * A cell's look: Markdown's table cell, its least width that of its words on one line or 12em (CELL_FLOOR, measured on
 * the cell's start alone, which is that much and more). Folded, its lines fold at its edge, anywhere if a word is longer;
 * whole, it keeps each line as written and the table scrolls sideways. Its line breaks are kept either way.
 */
const CELL = "border border-line px-2 py-1 text-left align-top";
const FIT = 64;
/** A cell the record does not have (it is shorter than the widest): hatched, so it does not read as an empty string. */
const MISSING = "bg-[repeating-linear-gradient(135deg,var(--color-line)_0_1px,transparent_1px_6px)]";

function Row({ number, cells, columns, wrapped, head = false }: { number: number; cells: string[]; columns: number; wrapped: boolean; head?: boolean }) {
  const Cell = head ? "th" : "td";
  const flow = wrapped ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre [overflow-wrap:normal]";
  const cellClass = cn(CELL, CELL_FLOOR, flow, head ? "bg-hover font-semibold" : "font-normal");
  const missingClass = cn(CELL, MISSING);
  return <tr>
    {/* Its number is not the file's: a selection leaves it out. */}
    <th scope="row" className={cn(CELL, "px-1.5 text-right align-top text-xs font-normal whitespace-nowrap text-muted tabular-nums select-none [overflow-wrap:normal]", head && "bg-hover")}>{number}</th>
    {Array.from({ length: columns }, (_, k) => k < cells.length
      ? <Cell key={k} scope={head ? "col" : undefined} data-fit={cells[k]!.slice(0, FIT)} className={cellClass}>{cells[k]}</Cell>
      : <Cell key={k} data-missing="" className={missingClass} />)}
  </tr>;
}
