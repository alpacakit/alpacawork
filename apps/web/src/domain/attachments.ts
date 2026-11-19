import { z } from "zod";
import { isMedia } from "./task-files";

/**
 * A file attached to an instruction. It is saved under the task's folder as soon as it is attached (`path`, relative
 * to the Task folder), and the instruction names it by `absolutePath`, a server file URL the receiving agent can
 * open. The sent instruction is the typed words, then one line per file: `![name](absolutePath)` for media and
 * `[name](absolutePath)` for any other file, so History shows exactly what the agent received.
 */
const attachmentsSchema = z.array(z.object({ name: z.string(), path: z.string(), absolutePath: z.string(), size: z.number() }));
export type Attachment = z.infer<typeof attachmentsSchema>[number];

/** The count both reference products keep per message. A file's size limit is the workspace's (useAttachmentBytes). */
export const MAX_ATTACHMENTS = 20;
/** A pasted text longer than this becomes a text file, as ChatGPT does at 10k characters. */
export const PASTE_AS_FILE_CHARACTERS = 10_000;

/** The draft keeps its attached files as one JSON value, so a reload or a resend keeps them. */
export function attachmentsOf(values: Record<string, string>): Attachment[] {
  try { return attachmentsSchema.parse(JSON.parse(values.attachments ?? "[]")); } catch { return []; }
}
/** A draft's next send ID can change; a saved file keeps the storage identity in its path. */
export function attachmentLocation(file: Attachment): { requestId: string; name: string } {
  const parts = /^attachments\/([^/]+)\/([^/]+)$/.exec(file.path);
  if (!parts) throw new Error('Invalid saved attachment path');
  return { requestId: parts[1]!, name: parts[2]! };
}
/** The files a request holds that are saved elsewhere, not under its own ID: each is copied there, under one operation ID. */
export const attachmentsToCopy = (values: Record<string, string>, requestId: string) =>
  attachmentsOf(values).filter(file => attachmentLocation(file).requestId !== requestId);
export const attachmentsValue = (list: readonly Attachment[]): Record<string, string> => list.length ? { attachments: JSON.stringify(list) } : {};

/** Brackets and parentheses would end the Markdown link; the server makes the rest of the name safe. */
export const linkSafeName = (name: string) => name.replace(/[[\]()]/g, "_");

const ATTACHMENT_LINE = /^(!?)\[([^\]]*)\]\((\/[^)]*)\)$/;

/**
 * Split a sent instruction into its words and the files it attached from `folder` (the task's file URL prefix):
 * the trailing lines that each link a file under its `attachments/`. Anything else stays in the words.
 */
export function splitAttachments(body: string, folder: string | null): { words: string; files: { name: string; path: string; media: boolean }[] } {
  let end = body.length;
  const files: { name: string; path: string; media: boolean }[] = [];
  // A link names its file by the folder's route and its `path`; the server also names the project in it.
  const route = folder === null ? null : new URL(folder, "http://task.invalid").pathname;
  while (route && end > 0) {
    const lineStart = body.lastIndexOf("\n", end - 1);
    const match = ATTACHMENT_LINE.exec(body.slice(lineStart + 1, end).trim());
    let path: string | null = null;
    if (match?.[3]) {
      try {
        const link = new URL(match[3], "http://task.invalid");
        if (link.pathname === route) path = link.searchParams.get("path");
      } catch { /* malformed link stays in the words */ }
    }
    if (!path?.startsWith("attachments/")) path = null;
    if (!match || !path) break;
    files.unshift({ name: match[2]!, path, media: isMedia(path) });
    end = lineStart < 0 ? 0 : lineStart;
  }
  return { words: body.slice(0, end).trim(), files };
}

/** A file's size as people read it: 820 B, 14 KB, 3.2 MB. */
export function sizeText(bytes: number, locale: string): string {
  let size = bytes, unit = "B", digits = 0;
  if (bytes >= 1024 ** 2) {
    size = bytes / 1024 ** 2;
    unit = "MB";
    digits = size < 10 ? 1 : 0;
  } else if (bytes >= 1024) {
    size = bytes / 1024;
    unit = "KB";
  }
  const number = new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${number.format(size)} ${unit}`;
}

/** The short type shown on a file card: its extension, or nothing. */
export const kindText = (name: string) => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toUpperCase() ?? "";
