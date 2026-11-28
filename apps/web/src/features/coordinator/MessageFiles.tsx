import { coordinatorFileUrl } from "@alpacawork/contract";
import { useTranslation } from "react-i18next";
import { isMedia } from "@/domain/task-files";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { CoordinatorTurn } from "@/data/coordinator";
import { useImageViewer, type SliderImage } from "@/features/reader/ImageSlider";
import { MediaThumb } from "@/features/reader/TaskMedia";

/**
 * What a message's files need: whose request they were uploaded under, and their names; one not yet held by serve also
 * says where each is read from meanwhile (`files`).
 */
type Files = Pick<CoordinatorTurn, "id" | "attachments"> & { files?: readonly string[]; filesExpired?: true };
const fileUrl = (turn: Files, name: string, index: number) => turn.files?.[index] ?? coordinatorFileUrl(turn.id, name);
/** Its images and videos, in the order attached: the slider plays a video where it shows an image. */
export const messageMedia = (turn: Files): SliderImage[] => {
  const media: SliderImage[] = [];
  turn.attachments.forEach((name, index) => {
    if (isMedia(name)) media.push({ id: `${turn.id}/${name}`, path: name, alt: name, src: fileUrl(turn, name, index) });
  });
  return media;
};
/**
 * An answer's files as its body draws them: one not ready keeps its link's words, with nothing to open; one cleaned away
 * with the old files says it was removed, as a message's own files do.
 */
export const answerBodyFiles = (turn: Pick<CoordinatorTurn, "id" | "answerFiles" | "filesExpired">) => turn.answerFiles?.map(file => {
  if (file.state !== "ready") return { path: file.href, name: file.href, size: 0, src: null, href: null };
  // Only a file that was kept can have been cleaned away.
  if (turn.filesExpired) return { path: file.href, name: file.name, size: file.size, src: null, href: null, removed: true as const };
  const url = coordinatorFileUrl(turn.id, file.name, "answers");
  return { path: file.href, name: file.name, size: file.size, src: url, href: url };
});
export type OpenMessageImages = ReturnType<typeof useImageViewer>["open"];

/** Thumbnails use the reader's viewer, including in the coordinator's own window. */
export function MessageFiles({ turn, open, all = false }: {
  turn: Files; open: OpenMessageImages; all?: boolean;
}) {
  const { t } = useTranslation("ui");
  // Removed by the cleaning of old conversation files: said once in their place, with nothing to open.
  if (turn.filesExpired) return <p data-coordinator-files-expired className="m-0 inline-flex min-h-lh items-center gap-1 text-xs text-muted">
    <Icon name="file" className="size-3.5 flex-none" /><span className="cap-box">{t("coordinatorCard.filesExpired", { count: turn.attachments.length })}</span></p>;
  const media = messageMedia(turn);
  const visible = !all && media.length > 4 ? media.slice(0, 3) : media;
  const rest = media.length - visible.length;
  const fileNames = turn.attachments.flatMap((name, index) => isMedia(name) ? [] : [{ name, href: fileUrl(turn, name, index) }]);
  const tile = cn("relative flex-none overflow-hidden rounded-sm border border-line bg-lit focus-visible:outline-2 focus-visible:outline-ink",
    all ? "h-11 w-14" : "h-16 w-24");
  return <div data-coordinator-files className="flex flex-wrap gap-1.5">
    {visible.map((item, index) => <button type="button" key={item.id} className={tile}
      aria-label={t("coordinatorCard.viewImage", { name: item.alt })} onClick={event => open(event.currentTarget, media, index)}>
      <MediaThumb name={item.path} src={item.src} className="size-full" />
    </button>)}
    {rest > 0 && <button type="button" className={cn(tile, "grid place-items-center")} aria-label={t("coordinatorCard.moreMedia", { count: rest })}
      onClick={event => open(event.currentTarget, media, visible.length)}>
      <MediaThumb name={media[visible.length]!.path} src={media[visible.length]!.src} badge={false} className="absolute inset-0 size-full opacity-30" />
      <span className="relative text-xs font-semibold tabular-nums">+{rest}</span>
    </button>}
    {fileNames.map(({ name, href }) => <a key={name} href={href} target="_blank" rel="noreferrer"
      className="inline-flex min-h-7 min-w-0 items-center gap-1 rounded-sm border border-line px-1.5 py-1 text-xs text-muted [overflow-wrap:anywhere] narrow:min-h-11">
      <Icon name="file" className="size-3.5 flex-none" /><span className="min-w-0 cap-box">{name}</span></a>)}
  </div>;
}
