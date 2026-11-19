import { MermaidImage } from "./MermaidImage";
import { Pre } from "@/components/ui/pre";
import { CodeCopy, CodeFrame } from "./CodeBlock";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import EmblaCarousel, { type EmblaCarouselType } from "embla-carousel";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { isComposingKey } from "@/components/ui/composing";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { useSurfaceDocument } from "@/lib/surface";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useViewStore } from "@/state/view-store";
import { useCloseOnPhoneBack } from "@/lib/close-on-back";
import { closeImage } from "@/state/history-step";
import { mediaKind, showsInTab } from "@/domain/task-files";
import { savedFileLink, type FileLink } from "@/data/task-file-url";
import { AudioTile, mediaUnavailable, pauseTaskMedia, TaskAudio, TaskVideo, VideoPoster } from "./TaskMedia";
import { viewerButton, viewerPill, videoControlRowHeight } from "./VideoControls";

/** `id` is what the URL's `image` names the slide by; `src` is a managed file's address (a Task's or the coordinator's). */
export type SliderImage = { id: string; path: string; alt: string; src: string; showable?: boolean; source?: string };

// Portals can put the viewer in another realm, so input ownership uses DOM capabilities, not instanceof Element.
const within = (target: EventTarget | null, selector: string) => typeof (target as Element | null)?.closest === "function" && !!(target as Element).closest(selector);
const viewerInFullscreen = (root: Element | null) => !!root && (!!root.ownerDocument.fullscreenElement || !!root.querySelector("[data-video-fullscreen]"));
const input = "input,textarea,select,[contenteditable]";
/** The browser's own players, whose controls a finger, a key or a click works rather than the slider. */
const player = "video,audio";

/**
 * A finger drags from the stage or media picture, leaving a video's controls, a sound's player and full-screen to the browser.
 * A mouse drags only an image or the empty stage; the wheel plugin sends its mousedown to the track. One slide
 * does not move. Pinch-zoomed, no touch or wheel reaches here: the page is the browser's to pan (lib/pinch-zoom.ts).
 */
const canDrag = (embla: EmblaCarouselType, event: MouseEvent | TouchEvent) => {
  // Asked without `instanceof`: in the coordinator's own window, events and elements are that window's, not this one's.
  const target = event.target;
  if (embla.slideNodes().length < 2 || viewerInFullscreen(embla.rootNode()) || within(target, `${input},audio`)) return false;
  if ("button" in event) return (target === embla.containerNode() || within(target, "[data-image-slider-large]")) && !within(target, "video");
  return true;
};
const instant = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One image viewing surface for reports and Task files. Embla moves the slides; `active` follows its selection. */
export function ImageSlider({ images, active, select, close }: {
  images: SliderImage[]; active: number; select: (index: number) => void; close: () => void;
}) {
  const { t } = useTranslation("reader");
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const videoPositions = useRef(new Map<string, number>());
  const [brokenSrc, setBrokenSrc] = useState<ReadonlySet<string>>(() => new Set());
  const [embla, setEmbla] = useState<EmblaCarouselType>();
  const multiple = images.length > 1;
  const mixed = images.some(item => { const kind = mediaKind(item.path); return kind === "video" || kind === "audio"; });
  // Made before the first paint, so keys and buttons move the slides from the moment the viewer opens. The dialog
  // fills the viewer, so a finger or a sideways wheel (its plugin listens on the track's parent) moves it from anywhere.
  useLayoutEffect(() => {
    // duration 12 settles a key or button step in about a 240ms ease-out; a released drag
    // keeps Embla's own speed from the finger's.
    const created = EmblaCarousel(dialog.current!, { container: "[data-image-slider-track]", startIndex: active,
      containScroll: false, duration: 12, watchDrag: canDrag }, [WheelGesturesPlugin()]);
    // A drag ends in a click Embla swallows, but the wheel plugin's drag ends without one, so Embla would swallow the
    // next real click (on Close, say). Hand it a click on the pager frame, which does nothing.
    created.on("pointerUp", () => {
      if (dialog.current!.classList.contains("is-wheel-dragging")) dialog.current!.querySelector("[data-image-slider-pager]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    setEmbla(created);
    return () => created.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one carousel per open viewer; `active` is only where it starts
  }, []);
  const image = images[active]!;
  useEscapeLayer(true, ESCAPE_LAYER.image, () => { if (!viewerInFullscreen(dialog.current)) close(); });
  // Over what opened it, in that window (the coordinator's own window too).
  const at = useSurfaceDocument();
  // Sticky toasts wait while the viewer covers its window; position is always the viewport's top centre.
  useLayoutEffect(() => notify.cover(at), [at]);
  // Keep input ownership while a subtree is removed or disabled: the browser may already have moved focus to BODY
  // when a child's error callback runs. A later focusin elsewhere relinquishes ownership, so valid controls are never stolen.
  useLayoutEffect(() => {
    const root = dialog.current!;
    let owned = root.contains(at.activeElement) ? at.activeElement as HTMLElement : null;
    const remember = (event: FocusEvent) => { if (event.target !== at.body) owned = root.contains(event.target as Node) ? event.target as HTMLElement : null; };
    const repair = () => {
      if (owned && (!root.contains(owned) || (owned.matches(":disabled") || !!owned.closest("[hidden]"))) &&
        (at.activeElement === at.body || at.activeElement === owned)) root.focus({ preventScroll: true });
    };
    const observer = new at.defaultView!.MutationObserver(repair);
    at.addEventListener("focusin", remember);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    return () => { observer.disconnect(); at.removeEventListener("focusin", remember); };
  }, [at]);
  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => { pauseTaskMedia(); }, [active]);
  useEffect(() => () => { pauseTaskMedia(); }, []);
  useEffect(() => {
    if (!embla) return;
    const follow = () => { if (embla.selectedScrollSnap() !== active) select(embla.selectedScrollSnap()); };
    // --pull runs from 0 on the centred slide to ±1 one slide away, so a neighbour's image rests against the side
    // nearer the centre and travels to the middle of its slot as it arrives, without a jump at the selection.
    const pull = () => {
      const slides = embla.slideNodes();
      const position = embla.scrollProgress() * (slides.length - 1);
      slides.forEach((slide, index) => {
        const value = String(Math.max(-1, Math.min(1, index - position)));
        if (slide.style.getPropertyValue("--pull") !== value) slide.style.setProperty("--pull", value);
      });
    };
    // Slides added or removed (a new report) keep the image the URL names.
    const keep = () => { embla.scrollTo(active, true); pull(); };
    pull();
    embla.on("select", follow).on("scroll", pull).on("reInit", keep);
    return () => { embla.off("select", follow).off("scroll", pull).off("reInit", keep); };
  }, [embla, active, select]);
  // The URL moved the selection itself (Back, Forward, a link): jump there.
  useEffect(() => { if (embla && embla.selectedScrollSnap() !== active) embla.scrollTo(active, true); }, [embla, active]);
  useEffect(() => {
    const onArrow = (event: KeyboardEvent) => {
      if (!multiple || viewerInFullscreen(dialog.current) || (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isComposingKey(event) ||
        within(event.target, `${input},${player}`)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowLeft") embla?.scrollPrev(instant()); else embla?.scrollNext(instant());
    };
    at.addEventListener("keydown", onArrow, true);
    return () => at.removeEventListener("keydown", onArrow, true);
  }, [embla, multiple, at]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation(); // Portals still bubble through the opener's React tree (forms and expandable reports).
    if (event.key !== "Tab" || !dialog.current || viewerInFullscreen(dialog.current)) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), video[controls], audio[controls]")]
      .filter(element => {
        const style = element.ownerDocument.defaultView!.getComputedStyle(element);
        return element.tabIndex >= 0 && style.display !== "none" && style.visibility !== "hidden";
      });
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && (at.activeElement === first || at.activeElement === dialog.current || !dialog.current.contains(at.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (at.activeElement === last || at.activeElement === dialog.current || !dialog.current.contains(at.activeElement))) {
      event.preventDefault(); first.focus();
    }
  };
  // Embla swallows the click that ends a drag, so a click reaching here is a tap on the backdrop.
  return createPortal(<div data-image-slider-modal className="fixed inset-0 z-(--layer-image-viewer) flex items-center justify-center bg-scrim/80 text-white"
    onClick={event => {
      event.stopPropagation();
      if (!within(event.target, "button,a,video,audio,[data-video-controls],[data-video-poster],[data-image-slider-details],[data-image-slider-large],[data-image-slider-neighbor],[data-image-slider-pager]")) close();
    }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={image.alt || image.path} tabIndex={-1}
      onKeyDown={onKeyDown} onClickCapture={event => {
        // Only a person's click: the one handed to Embla after a wheel leaves focus where it was.
        if (event.nativeEvent.isTrusted && !within(event.target, "button,a,video,audio,input,[data-video-controls]")) dialog.current?.focus();
      }} className="flex h-full w-full flex-col items-center overflow-clip py-4 outline-none [--slide-width:min(72vw,1400px)] narrow:[--slide-width:calc(100vw-40px)] [touch-action:pan-y_pinch-zoom]">
      <div className="flex w-full justify-end px-4 pb-3"><Button ref={closeButton} data-image-slider-close variant="quiet" size="icon"
        aria-label={mixed ? t("imageSlider.closeMedia") : t("imageSlider.closeImage")} className={cn(viewerButton, "border border-white/30 bg-scrim/50")}
        onClick={close}><Icon name="close" /></Button></div>
      <div data-image-slider-track className="flex min-h-0 w-full flex-1 gap-3 narrow:gap-2">
        {images.map((item, index) => {
          const current = index === active;
          const kind = mediaKind(item.path);
          const unavailable = item.showable === false || brokenSrc.has(item.src);
          // An image a tab can show opens there; any other file, or one that failed here, saves its original.
          const link: FileLink = !unavailable && showsInTab(item.path) ? { href: item.src, saves: false } : savedFileLink(item.src);
          const broken = () => setBrokenSrc(previous => new Set(previous).add(item.src));
          // Only the selected image and the two beside it load; the rest are empty slots until they come near.
          if (Math.abs(index - active) > 1) return <div key={item.id} className="h-full w-(--slide-width) flex-none" />;
          const neighbor = current ? {} : { role: "button", tabIndex: -1, "aria-label": item.alt || item.path, "data-image-slider-neighbor": "",
            onClick: () => { dialog.current?.focus(); embla?.scrollTo(index, instant()); } };
          const look = cn("translate-x-[calc(var(--pull,0)*(50%_-_var(--slide-width)/2))]",
            !current && "cursor-pointer opacity-40 transition-opacity hover:opacity-70");
          return <div key={item.id} className="flex h-full w-(--slide-width) flex-none items-center">
            <figure data-image-slider-current={current ? "" : undefined} className="flex max-h-full w-full min-w-0 flex-col items-center justify-center">
              {unavailable
                ? <span {...neighbor} className={cn("text-center text-sm", look)}>{current ? mediaUnavailable(t, kind, item.alt || item.path) : item.alt}</span>
                : item.source !== undefined
                ? <span className="contents [&_[data-diagram-failed]]:text-center [&_[data-diagram-failed]]:text-white"><MermaidImage {...neighbor} data-image-slider-large={current ? "" : undefined} source={item.source} alt={current ? item.alt : ""}
                    enlarge={2} fit="(100dvh - 200px)"
                    className={cn("block h-auto min-h-0 max-h-[calc(100dvh-200px)] w-auto max-w-full object-contain", look)}
                    fallback={<CodeFrame className="mt-2 mb-type-block max-h-[calc(100dvh-240px)] max-w-full overflow-auto text-ink">
                      <CodeCopy text={item.source} className="float-end -me-1 -mt-1 ms-2 size-7 min-h-7" />
                      <Pre className="m-0 border-0 bg-transparent p-0">{item.source}</Pre></CodeFrame>} /></span>
                : kind === "audio"
                ? current
                  ? <TaskAudio src={item.src} label={item.alt || item.path} onError={broken} />
                  : <span {...neighbor} className={cn("block w-full max-w-md", look)}><AudioTile className="h-14 w-full rounded-lg" /></span>
                : kind === "video"
                ? current
                  ? <TaskVideo viewer data-image-slider-large src={item.src} aria-label={item.alt || item.path}
                      startAt={videoPositions.current.get(item.src)}
                      onPositionChange={time => videoPositions.current.set(item.src, time)}
                      onError={broken}
                      className="block h-auto min-h-0 max-h-[calc(100dvh-252px)] w-auto max-w-full rounded-lg object-contain" />
                  : <><span {...neighbor} data-video-poster className={cn("block max-h-[calc(100dvh-252px)] max-w-full overflow-hidden rounded-lg", look)}>
                      <VideoPoster src={item.src} className="max-h-[calc(100dvh-252px)] max-w-full" badge={false} />
                    </span><div aria-hidden="true" className={cn("mt-2 flex-none", videoControlRowHeight)} /></>
                : <img {...neighbor} data-image-slider-large={current ? "" : undefined} src={item.src} alt={current ? item.alt : ""} draggable={false}
                  onError={broken}
                  className={cn("block h-auto min-h-0 max-h-[calc(100dvh-200px)] w-auto max-w-full rounded-lg object-contain", look)} />}
              {/* Every slide keeps the caption's height, so an image does not shift up as it becomes the selected one. */}
              {current ? <figcaption data-image-slider-details className="mt-2 flex w-full justify-center text-center text-sm text-white">
                {item.source !== undefined ? <span data-image-slider-caption className="inline-flex min-h-11 items-center px-2">{item.alt}</span> : <a data-image-slider-caption href={link.href} {...link.saves ? { download: "" } : { target: "_blank", rel: "noreferrer noopener" }}
                  aria-label={link.saves ? t("imageSlider.saveOriginal", { name: item.alt || item.path }) : t("imageSlider.openOriginalInNewTab", { name: item.alt || item.path })}
                  className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded px-2 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white [&::after]:hidden">
                  <span className="min-w-0 truncate">{item.alt}</span><span aria-hidden="true" className="flex-none">{link.saves ? "↓" : "↗"}</span>
                </a>}
              </figcaption> : <div aria-hidden="true" className="mt-2 h-11" />}
            </figure>
          </div>;
        })}
      </div>
      {multiple && <div data-image-slider-pager className={cn(viewerPill, "mt-3")}>
        <Button type="button" variant="quiet" size="icon" aria-label={mixed ? t("imageSlider.previousMedia") : t("imageSlider.previousImage")}
          disabled={active === 0} onClick={() => embla?.scrollPrev(instant())}
          className={viewerButton}><Icon name="left" /></Button>
        <span data-image-slider-count className="min-w-14 text-center tabular-nums">{t("imageSlider.position", { current: active + 1, total: images.length })}</span>
        <Button type="button" variant="quiet" size="icon" aria-label={mixed ? t("imageSlider.nextMedia") : t("imageSlider.nextImage")}
          disabled={active === images.length - 1} onClick={() => embla?.scrollNext(instant())}
          className={viewerButton}><Icon name="right" /></Button>
      </div>}
    </div>
  </div>, at.body);
}

/** Focus goes back to what opened the viewer, on that window's frame: the app's stops while it is behind the coordinator's own window. */
const focusBack = (from: HTMLElement) => (from.ownerDocument.defaultView ?? window).requestAnimationFrame(() => from.focus());

/** The slider over a list whose open image the URL names (a report feed, a Files sheet). */
export function UrlImageSlider({ images }: { images: SliderImage[] }) {
  const id = useViewStore(state => state.image);
  const active = id ? images.findIndex(image => image.id === id) : -1;
  if (active < 0) return null;
  return <ImageSlider images={images} active={active}
    select={index => useViewStore.getState().setImage(images[index]!.id)} close={closeImage} />;
}

/**
 * The slider over a list its opener holds (a draft's files, an image outside a report feed): `open` shows `images`
 * from `active`, and focus returns to `from` once it closes. `viewer` is rendered beside the opener.
 */
export function useImageViewer() {
  const [shown, setShown] = useState<{ images: SliderImage[]; active: number; from: HTMLElement | null } | null>(null);
  // Open for a moment only: on a phone Back closes it along with the page's step.
  useCloseOnPhoneBack(!!shown, () => setShown(null));
  const open = useCallback((from: HTMLElement | null, images: SliderImage[], active: number) => setShown({ images, active, from }), []);
  const close = () => {
    const from = shown?.from;
    setShown(null);
    if (from) focusBack(from);
  };
  const viewer = shown && <ImageSlider images={shown.images} active={shown.active}
    select={active => setShown(current => current ? { ...current, active } : null)} close={close} />;
  return { open, viewer };
}

/** Opens a URL-named image from `opener`; focus returns there once the URL no longer names an image. */
export function useOpenUrlImage() {
  const opener = useRef<HTMLElement | null>(null);
  const id = useViewStore(state => state.image);
  useEffect(() => {
    const element = opener.current;
    if (id || !element) return;
    opener.current = null;
    focusBack(element);
  }, [id]);
  return (from: HTMLElement, image: string) => { opener.current = from; useViewStore.getState().setImage(image); };
}
