import { create } from "zustand";
import type { MissingFile } from "@/features/reader/Attachments";
import { useConversation } from "./coordinator";
import { recordFailure } from "@/lib/notify";

/**
 * What another app shared to this one (the manifest's share_target), on its way into the coordinator's input. sw.js
 * keeps a share in the cache below and opens the screen; the screen reads it here, and the input attaches the
 * files the same way as chosen or dropped ones. Nothing is sent: the person writes and sends. A file of any kind comes;
 * one the worker could not keep comes as missing, so the input names it beside the others.
 */
export type Shared = { id: string; files: (File | MissingFile)[]; text: string };
const SHARE_INBOX = "share-inbox";
const FRESH_MS = 10 * 60_000;

export const useShared = create<{ shared: Shared | null }>(() => ({ shared: null }));

/** The words that came with a share, one per line, without a repeated line or a link the text already holds. */
export function sharedText(title: string, text: string, url: string): string {
  [title, text, url] = [title.trim(), text.trim(), url.trim()];
  return [...new Set([title, text, text.includes(url) ? "" : url])].filter(Boolean).join("\n");
}
/** Types whose usual extension is not their subtype. */
const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/svg+xml": "svg", "video/quicktime": "mov", "video/x-matroska": "mkv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-wav": "wav", "text/plain": "txt", "text/markdown": "md",
  "application/x-zip-compressed": "zip", "application/msword": "doc", "application/vnd.ms-excel": "xls", "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx" };
/**
 * A file named without any extension (some apps share so) gets one from its type, so a picture or a video shows and
 * opens as one and any other file says its kind on its card.
 */
export function sharedName(name: string, type: string): string {
  const kind = EXTENSIONS[type] ?? /^\w+\/([a-z0-9]{1,6})$/.exec(type)?.[1];
  return !kind || /\.\w+$/.test(name) ? name : `${name || (type.startsWith("image/") ? "image" : "file")}.${kind}`;
}

/** One startup read shared by the app entrypoint and navigation's launch decision. */
let initialShare: Promise<boolean> | undefined;
export const takeInitialShared = () => initialShare ??= takeShared().catch((error: unknown) => { recordFailure(error, "share target: take"); return false; });

/** At start-up: a waiting share opens the coordinator with it. The inbox is retained until the editor commits its words and accepts its files. */
export async function takeShared(): Promise<boolean> {
  if (navigator.locks) return navigator.locks.request(SHARE_INBOX, readShared);
  return readShared();
}
async function readShared(): Promise<boolean> {
  if (typeof caches === "undefined" || !(await caches.has(SHARE_INBOX))) return false;
  let shared: Shared | null = null;
  try {
    const inbox = await caches.open(SHARE_INBOX);
    const list = await (await inbox.match("/share/list"))?.json() as
      { at: number; title: string; text: string; url: string; files: { name: string; type: string; size: number }[] } | undefined;
    if (list) {
      const id = JSON.stringify(list);
      if (await inbox.match(receiptKey(id))) return false;
      const claimed = await inbox.match(claimKey(id));
      if (!claimed && Date.now() - list.at >= FRESH_MS) {
        // Unopened, expired shares retain the existing policy. A claimed share never expires while held.
        if (navigator.locks) await caches.delete(SHARE_INBOX);
        else await inbox.put(receiptKey(id), new Response('expired'));
        return false;
      }
      if (!claimed) await inbox.put(claimKey(id), new Response('claimed'));
      const files = await Promise.all(list.files.map(async (file, index) => {
        const name = sharedName(file.name, file.type);
        const kept = await inbox.match(`/share/${index}`);
        return kept ? new File([await kept.blob()], name, { type: file.type }) : { name, size: file.size, missing: true as const };
      }));
      shared = { id, files, text: sharedText(list.title, list.text, list.url) };
    }
  } catch (error) { recordFailure(error, "share target: read"); return false; }
  if (!shared || !shared.files.length && !shared.text) return false;
  useShared.setState({ shared });
  useConversation.getState().setOpen(true);
  return true;
}

const claimKey = (id: string) => `/share/claimed?receipt=${encodeURIComponent(id)}`;
const receiptKey = (id: string) => `/share/received?receipt=${encodeURIComponent(id)}`;

/** The producer uses this same lock. A receipt for an older share cannot delete a newer inbox. */
export async function acknowledgeShared(shared: Shared): Promise<void> {
  if (typeof caches !== 'undefined' && navigator.locks) await navigator.locks.request(SHARE_INBOX, async () => {
    if (!await caches.has(SHARE_INBOX)) return;
    const inbox = await caches.open(SHARE_INBOX);
    const current = await (await inbox.match('/share/list'))?.json();
    if (current && JSON.stringify(current) === shared.id) await caches.delete(SHARE_INBOX);
  });
  else if (typeof caches !== 'undefined' && await caches.has(SHARE_INBOX)) {
    // An individual receipt cannot erase a concurrent arrival, even without Web Locks.
    const inbox = await caches.open(SHARE_INBOX);
    await inbox.put(receiptKey(shared.id), new Response('received'));
  }
  if (useShared.getState().shared === shared) useShared.setState({ shared: null });
}
