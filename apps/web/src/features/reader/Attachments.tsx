import { countUse } from '@/features/telemetry/count';
import { onBackInReach } from "@/data/connection";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { attachmentFileUrl, attachmentFromResult, getAttachmentOperation, uploadAttachment, removeAttachment, admitAttachmentRemoval, type AttachmentDestination, type AttachmentOperation } from "@/data/attachments";
import { ApiError, retryOf } from "@/data/client";
import { useAttachmentBytes, useWriteDisabled } from "@/data/queries";
import { attachmentLocation, attachmentsOf, attachmentsValue, kindText, linkSafeName, MAX_ATTACHMENTS, PASTE_AS_FILE_CHARACTERS,
  sizeText, type Attachment } from "@/domain/attachments";
import { isAudio, isImage, isMedia, isVideo } from "@/domain/task-files";
import { useImageViewer, type SliderImage } from "./ImageSlider";
import { VideoPoster } from "./TaskMedia";
import { updateDraft, useDraftStore, type DraftEntry } from "@/features/forms/draft-store";
import { cn } from "@/lib/utils";
import { useSurfaceDocument } from "@/lib/surface";
import { notify, recordFailure } from "@/lib/notify";
import { describeProblem, problemText, SaidFailure } from "@/features/forms/problem-text";

/** The file bytes exist only until reload; the draft keeps the identity needed to read the server's result. */
type Pending = { id: string; name: string; file: File | null; size: number; preview: string | null; progress: number;
  error: string | Error | null; uncertain?: boolean; removeAfterUpload?: string; recovery?: "checking" | Exclude<AttachmentOperation["state"],"committed">;
  /** Waiting its turn behind `mayShare`: the request it goes out under, once that one has settled. */
  queued?: string };
/**
 * Only the server knows whether two files are one, by their bytes, and it then gives them one path. Files that may be one
 * go out one at a time: what becomes of the first, its removal above all, is settled before the next is sent. A file
 * whose answer was lost, or whose result is still being looked for after a reload, may be saved: it is not settled
 * until that is known. Only a file that cannot be saved waits, so taking it out while it waits leaves nothing behind.
 */
const mayShare = (one: Pending, other: Pending) => one.id !== other.id && one.name === other.name && one.size === other.size;
const unsettled = (item: Pending) => item.queued === undefined
  && (item.recovery ? !settledUpload(item.recovery) : !!item.file && (!item.error || !!item.uncertain));
const uploadRecordSchema = z.object({ destination: z.string(), requestId: z.string(), opId: z.string(), name: z.string(), size: z.number() }).strict();
type UploadRecord = z.infer<typeof uploadRecordSchema>;
const uploadsOf = (values: Record<string, string>): UploadRecord[] => {
  try { return z.array(uploadRecordSchema).parse(JSON.parse(values.uploadOps ?? "[]")); } catch { return []; }
};
/** Kept outside the composer, so a reader that closes mid-upload still finds the file in the draft when it opens again. */
const usePending = create<Record<string, Pending[]>>(() => ({}));
const useRemoving = create<Record<string, boolean>>(() => ({}));
/** A saved picture keeps showing the copy read on this device (by its saved path), rather than blinking while it is fetched again. */
const previews = new Map<string, string>();
/** A preview is a data URL held in memory (a third larger than the file), so a larger picture goes without one. */
const PREVIEW_BYTES = 20 * 1024 * 1024;
const EMPTY: Pending[] = [];
/** The server's answer to these will not change: reloading says the same, and only a hand takes the card out. No answer sends it again. */
const settledUpload = (recovery: Pending["recovery"]) => recovery === "not_found" || recovery === "before_restore" || recovery === "unknown_after_restore";
const attachmentFailure = (error: unknown): Error => error instanceof Error ? error : new Error("Attachment operation failed", { cause: error });
const attachmentProblem = (error: string | Error) => typeof error === "string" ? error : problemText(error);
type Removal = { requestId: string; opId: string };
/** A file named without its bytes (shared, but the device could not keep it): it stands among the cards as one that did not come. */
export type MissingFile = { name: string; size: number; missing: true };
const setPending = (key: string, change: (list: Pending[]) => Pending[]) =>
  usePending.setState(state => ({ [key]: change(state[key] ?? EMPTY) }));

/**
 * The files attached to one draft (`key`) at its `destination`. Saved files live in the draft's
 * values, so a reload, a refusal and a resend keep them; files on their way live beside it. `locked` while the
 * draft is being sent or its answer is unknown: then nothing is added or removed.
 */
type AttachmentDraft = { identity: string; locate: () => string; project?: (entries: Record<string, DraftEntry>, input: string) => Record<string, string> | undefined };
export function useAttachments(key: string, destination: AttachmentDestination, locked: boolean, owner?: AttachmentDraft) {
  const { t } = useTranslation("people");
  // What happens to these files is said in the window they were attached in.
  const at = useSurfaceDocument();
  const destinationKey = destination.kind === "task" ? `task:${destination.taskId}` : `coordinator:${destination.conversationId}`;
  const values = useDraftStore(useShallow(state => owner?.project ? owner.project(state.entries, key) : state.entries[key]?.values));
  // A movable draft supplies its stable file identity and its one storage owner.
  const requestId = values?.requestId ?? values?.operationId;
  const fileKey = owner?.identity ?? key;
  const location = owner?.locate ?? (() => key);
  const unavailable = useDraftStore(state => state.unavailable);
  const attached = values ? attachmentsOf(values) : [];
  const pending = usePending(state => state[fileKey] ?? EMPTY);
  const removing = useRemoving(state => !!state[fileKey]);
  const editable = !locked && !unavailable && !!values;
  const unreachable = useWriteDisabled();
  // New capture needs the server; a picker already opened may return during its foreground connection check.
  const disabled = !editable || unreachable;
  const maxBytes = useAttachmentBytes();
  // A preview is kept only while its file is in a draft: a sent or removed file lets its copy go.
  const paths = attached.map(file => file.path).join("\n");
  const kept = useRef<string[]>([]);
  useEffect(() => {
    const now = paths ? paths.split("\n") : [];
    for (const path of kept.current) if (!now.includes(path)) previews.delete(path);
    kept.current = now;
  }, [paths]);
  /**
   * The one write of these fields into the draft where it is now, all in one save: null keeps no field at all, as a
   * draft with nothing there has none. False when there is no draft, or the save failed.
   */
  const writeFields = (fields: (values: Record<string, string>) => Record<string, string | null>) => {
    const entry = useDraftStore.getState().entries[location()];
    if (!entry) return false;
    const values = { ...entry.values };
    for (const [field, value] of Object.entries(fields(entry.values))) {
      delete values[field];
      if (value !== null) values[field] = value;
    }
    return updateDraft(location(), { values });
  };
  const save = (change: (list: Attachment[]) => Attachment[], completed?: string) => writeFields(values => ({
    attachments: attachmentsValue(change(attachmentsOf(values))).attachments ?? null,
    ...(completed ? { completedUploads: JSON.stringify([...new Set([...JSON.parse(values.completedUploads ?? "[]"), completed])]) } : {}),
  }));
  const rememberUpload = (record: UploadRecord | null, opId: string) => writeFields(values => {
    const uploads = uploadsOf(values).filter(each => each.opId !== opId);
    if (record) uploads.push(record);
    return { uploadOps: uploads.length ? JSON.stringify(uploads) : null };
  });
  /**
   * An upload's end: its record goes and its card leaves, once. Storage that cannot take the change does not hold the
   * card: the draft store says so on screen, and a record left behind is settled by its receipt on the next load.
   */
  const finishUpload = (id: string) => {
    rememberUpload(null, id);
    setPending(fileKey, list => list.filter(each => each.id !== id));
    sendNext();
  };
  /** The next file whose turn has come, now that one has left or failed. */
  const sendNext = () => {
    const list = usePending.getState()[fileKey] ?? EMPTY;
    for (const item of list) {
      if (item.queued === undefined || list.some(each => unsettled(each) && mayShare(each, item))) continue;
      change(item.id, { queued: undefined });
      startUpload(item, item.queued);
      return sendNext();
    }
  };
  /** The file on its way as the store holds it now: what a callback captured may have changed or gone meanwhile. */
  const onItsWay = (id: string) => usePending.getState()[fileKey]?.find(each => each.id === id);
  const change = (id: string, patch: Partial<Pending>) => setPending(fileKey, list => list.map(each => each.id === id ? { ...each, ...patch } : each));
  /** A saved file into the draft, once however many answers say so; `upload` is the operation that saved it. */
  const keepSaved = (saved: Attachment, upload?: string) => save(list => list.some(each => each.path === saved.path) ? list : [...list, saved], upload);
  useEffect(() => {
    // Reuse the same receipt GET after reconnect; never resend bytes lost on reload.
    const recover = () => {
      const records = uploadsOf(useDraftStore.getState().entries[location()]?.values ?? {}).filter(each => each.destination === destinationKey);
      for (const record of records) {
        // Closing and reopening this composer in the same tab keeps the File and its in-flight XHR.
        if (onItsWay(record.opId)?.file) continue;
        setPending(fileKey, list => list.some(each => each.id === record.opId) ? list : [...list,
          { id: record.opId, name: record.name, file: null, size: record.size, preview: null, progress: 0,
            error: t("attach.checking"), recovery: "checking" }]);
        void getAttachmentOperation(record.opId).then(result => {
          if (result.state === "committed") {
            const saved = attachmentFromResult(destination, result.body);
            if (!saved || result.status !== 200 || !saved.path.startsWith(`attachments/${record.requestId}/`) || saved.size !== record.size)
              throw new ApiError(() => t("attach.receiptMismatch"), "invalid_response");
            if (!keepSaved(saved, record.opId)) throw new SaidFailure(t("attach.storageUnavailable"));
            finishUpload(record.opId);
          } else {
            const message = result.state === "not_found" ? t("attach.reselect") : settledUpload(result.state) ? t("attach.restored") : t("attach.unconfirmed");
            change(record.opId, { error: message, recovery: result.state });
            sendNext();
          }
        }).catch(error => {
          recordFailure(error, "attachment check");
          change(record.opId, { error: attachmentFailure(error), recovery: "pending" });
        });
      }
    };
    recover();
    return onBackInReach(recover);
  }, [fileKey, destinationKey]);
  const removals = () => {
    const raw = useDraftStore.getState().entries[location()]?.values.removeOps;
    try { return raw ? JSON.parse(raw) as Record<string, Removal> : {}; } catch { return {}; }
  };
  const recordRemoval = (path: string, removal: Removal | null) => {
    const ids = { ...removals() };
    if (removal) ids[path] = removal;
    else delete ids[path];
    return writeFields(() => ({ removeOps: Object.keys(ids).length ? JSON.stringify(ids) : null }));
  };
  const rememberRemoval = (path: string, removal: Removal | null) => {
    if (!recordRemoval(path, removal)) throw new SaidFailure(t("attach.storageUnavailable"));
  };
  /** Only serve's terminal restore refusal closes this retained removal; local missing proof stays unproven. */
  const removalFailure = (path: string, opId: string, error: unknown): unknown => {
    const detail = error instanceof ApiError ? error.detail : null;
    const restored = error instanceof ApiError && error.code === "restore_changed" && detail !== null
      && typeof detail === "object" && "notFoundProvesUnexecuted" in detail && detail.notFoundProvesUnexecuted === false;
    if (restored && removals()[path]?.opId === opId && !recordRemoval(path, null))
      return new SaidFailure(t("attach.storageUnavailable"), { cause: error });
    return error;
  };
  const startUpload = (item: Pending, id: string, recovering = false) => {
    if (!item.file) return;
    uploadAttachment(destination, id, item.file, linkSafeName(item.name), progress => change(item.id, { progress }), new AbortController().signal, item.id).then(saved => {
      const current = onItsWay(item.id);
      if (current?.removeAfterUpload) {
        const inDraft = attachmentsOf(useDraftStore.getState().entries[location()]?.values ?? {}).some(each => each.path === saved.path);
        if (inDraft) finishUpload(item.id);
        else {
          // The person's removal stands even when this session can no longer record it.
          const removeOpId = current.removeAfterUpload;
          recordRemoval(saved.path, { requestId: id, opId: removeOpId });
          void removeAttachment(destination, id, saved.name, removeOpId).then(() => {
            recordRemoval(saved.path, null);
            finishUpload(item.id);
          }, error => {
            keepSaved(saved);
            finishUpload(item.id);
            notify.failure(removalFailure(saved.path, removeOpId, error), { about: "attachment: remove after upload", from: at });
          });
        }
        return;
      }
      if (!current) return;
      if (current.preview) previews.set(saved.path, current.preview);
      if (keepSaved(saved, item.id)) finishUpload(item.id);
      else change(item.id, { error: t("attach.storageUnavailable"), uncertain: true });
    }, (error: unknown) => {
      recordFailure(error, "attachment upload");
      const current = onItsWay(item.id);
      if (!current || error instanceof DOMException && error.name === "AbortError") return;
      // A lost reply may follow a completed save. Replay the same bytes to recover the server's chosen name.
      const uncertain = !!current.uncertain || retryOf(error) !== "fix";
      if (current.removeAfterUpload && uncertain && !recovering) {
        change(item.id, { error: null, uncertain: true, progress: 0 });
        startUpload(item, id, true);
      } else if (current.removeAfterUpload && !uncertain) finishUpload(item.id);
      else {
        if (!uncertain) rememberUpload(null, item.id);
        change(item.id, { error: attachmentFailure(error), uncertain, progress: 0 });
        sendNext();
      }
    });
  };
  const add = (files: readonly (File | MissingFile)[], ids?: readonly string[]) => {
    if (!editable || !requestId || !files.length) return;
    // Files recovered after a reload come with their ids; only a person's own adding counts.
    if (!ids) countUse('attach');
    const tooLarge = t("attach.tooLarge", { size: `${maxBytes / 1024 / 1024} MiB` });
    const incoming = files.map((file, at) => ({ file, id: ids?.[at] ?? crypto.randomUUID() })).filter(({ id, file }) => { const item = onItsWay(id); return !(item && (item.file || "missing" in file)); });
    let room = MAX_ATTACHMENTS - attached.length - pending.length;
    if (incoming.filter(({ id }) => !onItsWay(id)).length > room) notify.info(t("attach.tooMany", { limit: MAX_ATTACHMENTS }), { from: at });
    for (const { file, id } of incoming) {
      const known = onItsWay(id);
      if (!known && room-- <= 0) continue;
      // Told by its mark, not by `instanceof File`: a file picked or dropped in the picture-in-picture window is that window's File.
      if ("missing" in file) {
        // Nothing to send or to look for: taken out by hand, as a file gone from a reselect is.
        setPending(fileKey, list => [...list, {
          id, name: file.name || t("attach.unnamed"), file: null, size: file.size,
          progress: 0, preview: null, recovery: "not_found",
          error: file.size > maxBytes ? tooLarge : t("attach.notReceived") }]);
        continue;
      }
      const item: Pending = { id, name: file.name || t("attach.unnamed"), file, size: file.size, progress: 0, error: null, preview: null };
      setPending(fileKey, list => [...list.filter(each => each.id !== id), item]);
      // The picture shows while it is on its way. A data URL, as the screen's policy allows images only from itself and data.
      if (isImage(file.name) && file.size <= Math.min(maxBytes, PREVIEW_BYTES)) {
        const reader = new FileReader();
        reader.onload = () => change(id, { preview: typeof reader.result === "string" ? reader.result : null });
        reader.readAsDataURL(file);
      }
      if (file.size > maxBytes) {
        change(id, { error: tooLarge });
        continue;
      }
      if (!rememberUpload({ destination: destinationKey, requestId, opId: id, name: item.name, size: item.size }, id)) {
        change(id, { error: t("attach.storageUnavailable") });
        continue;
      }
      // A file brought back to its own operation may be saved already, so it goes on; only a new one, or one known not to have arrived, waits.
      const mayBeSaved = known && known.recovery !== "not_found";
      if (!mayBeSaved && (usePending.getState()[fileKey] ?? EMPTY).some(each => unsettled(each) && mayShare(each, item))) change(id, { queued: requestId });
      else startUpload(item, requestId);
    }
  };
  const remove = async (id: string) => {
    if (disabled || removing) return;
    try {
      const waiting = onItsWay(id);
      if (waiting) {
        if ((waiting.file || settledUpload(waiting.recovery)) && !save(list => list, id)) return;
        if (!waiting.file) {
          if (settledUpload(waiting.recovery)) finishUpload(id);
          return;
        }
        if (waiting.queued !== undefined) finishUpload(id);
        else if (waiting.error && waiting.uncertain && requestId) {
          change(id, { error: null, removeAfterUpload: waiting.removeAfterUpload ?? admitAttachmentRemoval(destination), progress: 0 });
          startUpload(waiting, requestId, true);
        } else if (waiting.error) finishUpload(id);
        else change(id, { removeAfterUpload: waiting.removeAfterUpload ?? admitAttachmentRemoval(destination) });
        return;
      }
      const file = attached.find(each => each.path === id);
      if (!file || !requestId) return;
      useRemoving.setState(state => ({ ...state, [fileKey]: true }));
      const stored = attachmentLocation(file);
      const removal = removals()[file.path] ?? { requestId: stored.requestId, opId: admitAttachmentRemoval(destination) };
      rememberRemoval(file.path, removal);
      try { await removeAttachment(destination, removal.requestId, stored.name, removal.opId); }
      catch (error) { throw removalFailure(file.path, removal.opId, error); }
      save(list => list.filter(each => each.path !== id));
      rememberRemoval(file.path, null);
    } catch (error) {
      notify.failure(error, { about: "attachment: remove", from: at,
        text: error instanceof ApiError && error.code === "write_unavailable" && error.cause
          ? t("attach.storageUnavailable") : undefined });
    } finally {
      useRemoving.setState(state => ({ ...state, [fileKey]: false }));
    }
  };
  /** Images and files on the clipboard are attached; a text longer than a message is kept whole as a text file. */
  const paste = (event: ClipboardEvent<HTMLElement>) => {
    if (disabled) return;
    const files = [...event.clipboardData.files];
    const text = event.clipboardData.getData("text/plain");
    if (files.length) {
      event.preventDefault();
      add(files.map(file => file.name && file.name !== "image.png" ? file
        : new File([file], `${t("attach.pastedImage")}-${stamp()}.${file.type.split("/")[1] ?? "png"}`, { type: file.type })));
    } else if ([...text].length > PASTE_AS_FILE_CHARACTERS) {
      event.preventDefault();
      add([new File([text], `${t("attach.pastedText")}-${stamp()}.txt`, { type: "text/plain" })]);
    }
  };
  // The pending file owns its outcome; this is its only message path. Upload operation IDs
  // keep a failed retry in the same shared toast slot, including files restored after reload.
  const said = useRef(new Map<string, string | Error>());
  const retryUpload = useRef<(id: string) => void>(() => {});
  retryUpload.current = (id) => {
    const item = onItsWay(id);
    if (requestId && !disabled && item?.error && item.file && item.uncertain) {
      change(id, { error: null, progress: 0 });
      startUpload(item, requestId);
    }
  };
  useEffect(() => () => {
    for (const id of said.current.keys()) notify.dismiss(`attachment-upload:${id}`);
    said.current.clear();
  }, [fileKey]);
  useEffect(() => {
    const failed = pending.filter(item => item.error);
    for (const id of said.current.keys()) if (!failed.some(item => item.id === id)) {
      notify.dismiss(`attachment-upload:${id}`);
      said.current.delete(id);
    }
    for (const item of failed) {
      if (said.current.get(item.id) === item.error) continue;
      const options = { id: `attachment-upload:${item.id}`, ongoing: true, from: at,
        action: item.file && item.uncertain ? { label: t("translation:retry"), run: () => retryUpload.current(item.id) } : undefined };
      if (typeof item.error === "string") notify.error(`${item.name}: ${item.error}`, options);
      else notify.failure(item.error, { ...options, about: "attachment save or check",
        detail: [item.name, describeProblem(item.error).detail].filter(Boolean).join(": ") });
      said.current.set(item.id, item.error!);
    }
  }, [pending, at, t]);
  return { attached, pending, disabled, removing, add, remove, paste,
    /** Sending waits until every file is saved, and a refused file is taken out by hand: nothing is left behind unnoticed. */
    waiting: pending.length > 0 || removing };
}
export type Attachments = ReturnType<typeof useAttachments>;

const stamp = () => new Date().toTimeString().slice(0, 8).replaceAll(":", "");

/** The input's “+”: picks files from the device (on a phone, the photo library and camera too). The same round tool as
 * the coordinator input's # and / (inputTool): 32px under a pointer, 44px on a phone or a touch screen. */
export function AttachButton({ attachments }: { attachments: Attachments }) {
  const { t } = useTranslation("people");
  const input = useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" variant="quiet" data-attach aria-label={t("attach.add")} title={t("attach.addHint")}
      disabled={attachments.disabled} onClick={() => input.current?.click()}
      className="size-8 flex-none rounded-full p-0 text-muted active:bg-line narrow:size-11 pointer-coarse:size-11">
      <Icon name="plus" className="size-4" />
    </Button>
    <input ref={input} type="file" multiple hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => { attachments.add([...event.target.files ?? []]); event.target.value = ""; }} />
  </>;
}

/** Files dragged anywhere over the window it is drawn in are dropped into the reader's one input (`enabled`). */
function useFileDrop(add: (files: File[]) => void, enabled: boolean) {
  const view = useSurfaceDocument().defaultView ?? window;
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const latest = useRef({ add, enabled });
  latest.current = { add, enabled };
  useEffect(() => {
    const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => { if (carriesFiles(event)) { depth.current++; setOver(true); } };
    // While the input is locked a drop is refused, still without the browser opening the file in place of the screen.
    const leave = (event: DragEvent) => { if (carriesFiles(event) && --depth.current <= 0) { depth.current = 0; setOver(false); } };
    // Without this the browser opens a dropped file in place of the screen.
    const overWindow = (event: DragEvent) => { if (carriesFiles(event)) { event.preventDefault(); event.dataTransfer!.dropEffect = "copy"; } };
    const dropped = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (latest.current.enabled) latest.current.add([...event.dataTransfer!.files]);
    };
    view.addEventListener("dragenter", enter);
    view.addEventListener("dragleave", leave);
    view.addEventListener("dragover", overWindow);
    view.addEventListener("drop", dropped);
    return () => {
      view.removeEventListener("dragenter", enter);
      view.removeEventListener("dragleave", leave);
      view.removeEventListener("dragover", overWindow);
      view.removeEventListener("drop", dropped);
    };
  }, [view]);
  return over && enabled;
}

/** One file as a card: an image as its picture, any other file as its kind, name and size. `open` shows it, pressed from `from`. */
type Card = { id: string; name: string; size?: number; src: string | null; progress?: number; error?: string | null; removable?: boolean;
  open?: (from: HTMLElement) => void };

/**
 * The files of a draft above its words, or of a sent instruction in History: one row, scrolled sideways when full.
 * In the input each card has its ×; a card with `open` opens its image or file.
 */
export function AttachmentCards({ cards, remove, removeDisabled, className }: {
  cards: readonly Card[]; remove?: (id: string) => void; removeDisabled?: boolean; className?: string;
}) {
  const { t, i18n } = useTranslation("people");
  if (!cards.length) return null;
  // The shared toast says what failed; the card keeps its failure mark.
  return <><ul data-attachments className={cn("m-0 flex list-none gap-1.5 overflow-x-auto p-0", className)}>
    {cards.map(card => {
      const image = !!card.src && isImage(card.name);
      const video = !!card.src && isVideo(card.name);
      const size = card.size !== undefined ? sizeText(card.size, i18n.language) : undefined;
      const busy = card.progress !== undefined && !card.error;
      const ring = busy && <UploadRing progress={card.progress!} label={t("attach.uploading", { name: card.name })} />;
      const face = video
        ? <VideoPoster src={card.src!} className="size-full" badge={false} />
        : image
        ? <img src={card.src!} alt="" className="size-full object-cover" />
        : <span className="flex min-w-0 items-center gap-2 pr-6 pl-2">
          <span className={cn("flex size-8 flex-none items-center justify-center rounded-sm border border-line bg-bg", card.error ? "text-error" : "text-muted")}>
            {busy ? ring : <Icon name={card.error ? "error" : isAudio(card.name) ? "sound" : "file"} className="size-4" />}</span>
          <span className="flex min-w-0 flex-col text-left">
            <span className="truncate text-xs text-ink">{card.name}</span>
            <span className="truncate text-xs text-muted">
              {[kindText(card.name), size].filter(Boolean).join(" · ")}</span>
          </span>
        </span>;
      const title = card.error ? `${card.name}\n${card.error}` : size !== undefined ? `${card.name} · ${size}` : card.name;
      const frame = cn("relative flex h-12 flex-none overflow-hidden rounded-sm border bg-lit", image || video ? "w-12" : "w-44",
        card.error ? "border-error" : "border-line");
      // A picture on its way cannot be opened yet: it is paled with white (in either theme), its progress a dark ring at its centre.
      const cover = (image || video) && (card.error
        ? <span className="absolute inset-0 flex items-center justify-center bg-scrim text-error"><Icon name="error" className="size-4" /></span>
        : busy && <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-pale text-pale-ink">{ring}</span>);
      return <li key={card.id} data-attachment={card.name} data-attachment-state={card.error ? "failed" : busy ? "uploading" : "saved"} className="group/card relative flex-none">
        {card.open ? <button type="button" title={title} onClick={event => card.open!(event.currentTarget)} className={cn(frame, "cursor-pointer hover:border-muted focus-visible:outline-2 focus-visible:outline-muted")}>{face}{cover}</button>
          : <div title={title} className={frame}>{face}{cover}</div>}
        {/* A 32px press centred on the corner: only 16px of the picture is covered; the row's padding and gap hold the rest. */}
        {remove && card.removable !== false && <button type="button" aria-label={t("attach.remove", { name: card.name })} disabled={removeDisabled} onClick={() => remove(card.id)}
          onPointerDown={(event) => event.preventDefault()}
          className="group/remove absolute -top-4 -right-4 flex size-8 items-center justify-center focus-visible:outline-none pointer-fine:opacity-0 pointer-fine:group-hover/card:opacity-100 pointer-fine:focus-visible:opacity-100">
          <span className="flex size-5 items-center justify-center rounded-full border border-line bg-lit text-muted group-hover/remove:text-ink group-focus-visible/remove:outline-2 group-focus-visible/remove:outline-muted pointer-coarse:size-6">
            <Icon name="close" className="size-3" /></span></button>}
      </li>;
    })}
  </ul>
  </>;
}

/** How much of a file has gone (0–1), as a ring as thin as a hairline bar, in the colour it is drawn in; nothing gone yet is its track alone. */
function UploadRing({ progress, label }: { progress: number; label: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return <svg role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    viewBox="0 0 20 20" className="size-5 -rotate-90" fill="none" strokeWidth={2}>
    <circle cx="10" cy="10" r="9" className="stroke-progress-track" />
    {percent > 0 && <circle cx="10" cy="10" r="9" pathLength={100} strokeDasharray={`${percent} 100`} strokeLinecap="round"
      className="stroke-current transition-[stroke-dasharray] ease-out" />}
  </svg>;
}

/** The input's cards: saved files (by their path) first, then the files on their way. A saved picture opens in the slider over the draft's pictures. */
export function DraftAttachments({ destination, attachments }: { destination: AttachmentDestination; attachments: Attachments }) {
  const { open, viewer } = useImageViewer();
  // Only a saved picture opens: its card stays put while the viewer is open, and the viewer shows the server's copy.
  const media: SliderImage[] = [];
  attachments.attached.forEach(file => {
    if (isMedia(file.name)) media.push({ id: file.path, path: file.name, alt: file.name, src: attachmentFileUrl(destination, file.path) });
  });
  const cards: Card[] = [
    ...attachments.attached.map(file => {
      const index = media.findIndex(item => item.id === file.path);
      return { id: file.path, name: file.name, size: file.size,
        src: isMedia(file.name) ? previews.get(file.path) ?? attachmentFileUrl(destination, file.path) : null,
        open: index < 0 ? undefined : (from: HTMLElement) => open(from, media, index) };
    }),
    ...attachments.pending.map(file => ({ id: file.id, name: file.name, size: file.size, src: file.preview, progress: file.progress,
      error: file.error ? attachmentProblem(file.error) : null, removable: !!file.file || settledUpload(file.recovery) })),
  ];
  return <>
    <AttachmentCards cards={cards} remove={attachments.disabled ? undefined : attachments.remove}
      removeDisabled={attachments.removing} className="gap-4 pt-4 pr-4 pl-4 narrow:pl-5.5 pointer-coarse:pl-5.5" />
    {viewer}
  </>;
}

/**
 * Everything a composer adds to its frame for files: the “+”, the cards, the drop over the window and the paste
 * into its field. One draft (`key`) owns them; `locked` as in useAttachments.
 */
export function useComposerFiles(key: string, destination: AttachmentDestination, locked: boolean, owner?: AttachmentDraft) {
  const attachments = useAttachments(key, destination, locked, owner);
  const dropping = useFileDrop(attachments.add, !attachments.disabled);
  return { attachments, onPaste: attachments.paste, frame: {
    attach: <AttachButton attachments={attachments} />,
    files: <DraftAttachments destination={destination} attachments={attachments} />,
    dropping,
  } };
}
