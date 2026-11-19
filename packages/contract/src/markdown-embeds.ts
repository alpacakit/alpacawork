/**
 * The one owner of what Markdown the screen draws as a part rather than as text: each kind, how it is written (a fenced
 * block's language, or the name of the file a `![purpose](path)` embeds), whether it joins the media list (a body's
 * gallery, markdownDocument's `media`) and whether a report may embed it (the writer checks it as it saves the report).
 * Every other place asks this table what a fence or a file is. How a kind is drawn is the screen's table
 * (apps/web/src/features/reader/embeds.tsx) and how a saved one is checked is the server's, each keyed by these kinds,
 * so a kind added here is a type error until both have a part for it.
 */
import { fileFormat, type FileMediaKind } from './file-formats.js';

type Written = { readonly fence: readonly string[] } | { readonly file: FileMediaKind };
type EmbedRule = { readonly written: Written; readonly gallery: boolean; readonly report: boolean };

export const EMBEDS = {
  /** ```diff and ```patch: a patch drawn as one (DiffBlock). */
  diffFence: { written: { fence: ['diff', 'patch'] }, gallery: false, report: false },
  /** ```mermaid: a diagram, in the gallery as a picture. */
  diagram: { written: { fence: ['mermaid'] }, gallery: true, report: false },
  image: { written: { file: 'image' }, gallery: true, report: true },
  video: { written: { file: 'video' }, gallery: true, report: true },
  audio: { written: { file: 'audio' }, gallery: true, report: true },
  /** A diff file (a report diff the CLI attached, or any patch): a diff card, not a picture. */
  diff: { written: { file: 'diff' }, gallery: false, report: true },
} as const satisfies Record<string, EmbedRule>;

type Embeds = typeof EMBEDS;
export type EmbedKind = keyof Embeds;
/** The kinds written as a fenced block, and as a file a `![purpose](path)` names. */
export type FenceKind = { [K in EmbedKind]: Embeds[K]['written'] extends { fence: readonly string[] } ? K : never }[EmbedKind];
export type FileKind = { [K in EmbedKind]: Embeds[K]['written'] extends { file: FileMediaKind } ? K : never }[EmbedKind];
/** The kinds that join the media list, and those a report may embed. */
export type GalleryKind = { [K in EmbedKind]: Embeds[K]['gallery'] extends true ? K : never }[EmbedKind];
export type GalleryFenceKind = FenceKind & GalleryKind;
export type GalleryFileKind = FileKind & GalleryKind;
export type ReportFileKind = { [K in FileKind]: Embeds[K]['report'] extends true ? K : never }[FileKind];

const kinds = Object.keys(EMBEDS) as EmbedKind[];
const written = (kind: EmbedKind): Written => EMBEDS[kind].written;

/** The kind a fenced block of this language (its first word, any case) is drawn as, or null for plain code. */
export function fenceKind(language: string): FenceKind | null {
  const word = language.toLowerCase();
  return (kinds.find(kind => { const way = written(kind); return 'fence' in way && way.fence.includes(word); }) as FenceKind | undefined) ?? null;
}

/** The kind a file of this name is embedded as, or null for a file that is no embed. */
export function fileKind(name: string): FileKind | null {
  return fileFormat(name)?.kind ?? null;
}

export const inGallery = (kind: EmbedKind): kind is GalleryKind => EMBEDS[kind].gallery;
/** The fenced kinds in the media list: their name is part of a medium's identity (markdownMediumId). */
export const galleryFenceKinds = kinds.filter(kind => 'fence' in written(kind) && inGallery(kind)) as GalleryFenceKind[];
/** Whether a report may embed a file of this kind (reportEmbed, the one reader of it). */
export const reportEmbeds = (kind: FileKind): kind is ReportFileKind => EMBEDS[kind].report;
