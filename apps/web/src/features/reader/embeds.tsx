import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FenceKind, FileKind, GalleryFenceKind } from "@alpacawork/contract";
import { CopyButton } from "@/components/ui/copy-button";
import type { FenceMedium } from "@/domain/markdown";
import { textClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { MermaidImage } from "./MermaidImage";
import { DiffBlock } from "./diff/DiffBlock";
import { readDiffCommand } from "@alpacawork/contract/report-diff";
import { DiffSummaryCard, type DiffSource } from "./diff/DiffSummary";

/**
 * How the screen draws each kind of Markdown the contract's EMBEDS table names (markdown-embeds.ts): one part per kind,
 * keyed by it, so a kind added there is a type error here until it has its part. What a fence or a file is, and whether
 * it joins the gallery, is the table's; only the drawing is here.
 */

/** A closed fence of an embedded kind, where MarkdownBody draws it. */
export type FenceAt = {
  text: string;
  /** The fence's medium when its kind joins the gallery (markdownDocument numbers it). */
  medium?: FenceMedium;
  /** The block's space above it, and the code frame's look for a frame that stands in that space or in a figure. */
  space: string;
  frame: (space?: string) => { className: string; codeClassName: string };
  /** The fence as plain code, for a part that falls back to it. */
  plain: (space?: string) => ReactNode;
  figureClassName: string;
  captionClassName: string;
  galleryReportKey?: string;
  mediumId: (medium: FenceMedium) => string;
  open: (from: HTMLElement | null, id: string) => void;
};
type FencePart = { draw: (at: FenceAt) => ReactNode };
/** A fence in the gallery also names itself there and in its caption. */
type GalleryFencePart = FencePart & { label: (t: TFunction, number: number) => string };

export const FENCE_PARTS: { [K in FenceKind]: K extends GalleryFenceKind ? GalleryFencePart : FencePart } = {
  diffFence: { draw: at => <DiffBlock text={at.text} {...at.frame(at.space)} /> },
  diagram: { draw: at => <Diagram {...at} />, label: (t, number) => t("reader:markdownBody.diagram", { number }) },
};

/** What a gallery fence is called in the gallery and under its drawing: "Diagram 2". */
export const fenceLabel = (t: TFunction, medium: FenceMedium) => FENCE_PARTS[medium.kind].label(t, medium.occurrence + 1);

/** A diagram: its drawing opens in the gallery, its name and the source's copy stand under it; until drawn, its code. */
function Diagram({ medium, space, plain, figureClassName, captionClassName, galleryReportKey, mediumId, open }: FenceAt) {
  const { t } = useTranslation("reader");
  if (!medium) return plain(space);
  const alt = fenceLabel(t, medium), id = mediumId(medium);
  return <div data-mermaid-figure className={space}>
    <MermaidImage source={medium.source} alt={alt} fallback={plain()} className={figureClassName}
      renderImage={image => <figure className="w-fit max-w-full"><button type="button" aria-label={alt} data-report-image-trigger=""
        data-report-key={galleryReportKey} data-media-id={id} onClick={event => open(event.currentTarget, id)}
        className="block max-w-full cursor-zoom-in">{image}</button>
        {/* The name and the source's copy stand under the drawing, as an image's caption does, so the copy covers none of it. */}
        <figcaption className={cn("flex items-center justify-between gap-2", captionClassName)}><span>{alt}</span>
          <CopyButton clip={() => textClip(medium.source)} label={t("markdownBody.copyCode")} className="-my-1.5 size-7 min-h-7" /></figcaption></figure>} />
  </div>;
}

/**
 * A file a `![purpose](path)` embeds. In a sentence it is drawn as `media` (a picture, a video or a sound, MarkdownMedia) or as
 * its file's `link`. A part with `ownParagraph` draws a paragraph of only such references, one a line, as one piece;
 * `standsFor` reads the code block right above it that the piece stands in for: the lines the piece shows in its place
 * (`standing`), or null to leave that block as it is.
 */
type FilePart = {
  inSentence: "media" | "link";
  ownParagraph?: (sources: DiffSource[], at: { space: string; standing: readonly string[] }) => ReactNode;
  standsFor?: (code: string) => string[] | null;
};
export const FILE_PARTS: { [K in FileKind]: FilePart } = {
  image: { inSentence: "media" },
  video: { inSentence: "media" },
  audio: { inSentence: "media" },
  diff: { inSentence: "link",
    ownParagraph: (sources, { space, standing }) => <DiffSummaryCard sources={sources} commands={standing} className={space} />,
    standsFor: diffCommands },
};

/**
 * The git commands a code block holds when it holds only `git diff`s of two commits, one a line (a `\` continues
 * one): the block the CLI wrote the report's diffs after, which their summary shows with each command to copy.
 */
function diffCommands(code: string): string[] | null {
  const commands = code.replace(/\\\n/g, " ").split("\n").filter(line => line.trim()).map(line => readDiffCommand(line));
  return commands.length && commands.every(found => found?.kind === "compare") ? commands.map(found => found!.command) : null;
}
