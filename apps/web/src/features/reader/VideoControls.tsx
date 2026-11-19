import type { CSSProperties, PointerEvent } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { durationText } from "@/lib/media-time";

/**
 * The viewer's own round button (close, ‹ ›, and the video's row): white over the picture in either theme, a 44px
 * target, and a white ring for the keyboard as the caption link has (the theme's muted ring is for the page).
 */
export const viewerButton = "min-h-11 min-w-11 rounded-full text-white hover:bg-white/10 hover:text-white focus-visible:outline-white focus-visible:-outline-offset-2 disabled:opacity-40 narrow:min-h-11 narrow:w-11";
/** The pager's pill: the row under a video is the same shape, so the two read as the viewer's controls. */
export const viewerPill = "flex min-h-11 items-center rounded-full border border-white/20 bg-scrim/70 px-1 text-sm text-white";

/** Includes the 44px controls and the pill’s two borders; neighbouring slides reserve this same row. */
export const videoControlRowHeight = "h-11.5";
const focusRange = (event: PointerEvent<HTMLInputElement>) => event.currentTarget.focus({ preventScroll: true });

/**
 * What the row draws, read from the video at each of its events (the video is the only owner of play, time and sound).
 * `duration` is undefined until the video knows it (before metadata, or a recording whose length is not written).
 */
export type VideoControlsLook = {
  paused: boolean; time: number; duration: number | undefined; muted: boolean; volume: number; volumeSettable: boolean; speed: number;
};
type VideoControlsActs = {
  toggle: () => void; seek: (time: number) => void; toggleMute: () => void; setVolume: (volume: number) => void;
  setSpeed: (speed: number) => void; fullScreen: () => void;
};

/** The speeds a person picks from, slow enough to follow an animation frame by frame. */
const VIDEO_SPEEDS = [0.2, 0.5, 1, 2];

/**
 * Every Task video's one speed control: the OS menu, so a phone opens its own large picker. Closed, it says the speed
 * the video plays at; a speed set elsewhere (the browser's full-screen menu) is shown as one more choice.
 */
export function VideoSpeed({ speed, choose, className }: { speed: number; choose: (speed: number) => void; className?: string }) {
  const { t } = useTranslation("reader");
  const options = useMemo(() => {
    const speeds = VIDEO_SPEEDS.includes(speed) ? VIDEO_SPEEDS : [...VIDEO_SPEEDS, speed].sort((a, b) => a - b);
    return speeds.map(choice => <option key={choice} value={String(choice)} className="bg-raised text-ink">{choice}x</option>);
  }, [speed]);
  return <select data-video-speed aria-label={t("imageSlider.speed")} value={String(speed)}
    onChange={event => choose(Number(event.currentTarget.value))}
    className={cn("cursor-pointer appearance-none rounded-full text-center text-sm tabular-nums text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white focus-visible:-outline-offset-2", className)}>
    {options}
  </select>;
}

/** The selected video's row, under its picture. Only a view: each control calls the video, and draws what it read. */
export function VideoControls({ look, act, className }: { look: VideoControlsLook; act: VideoControlsActs; className?: string }) {
  const { t } = useTranslation("reader");
  const known = look.duration !== undefined;
  const time = known ? Math.min(look.time, look.duration!) : look.time;
  const timeWords = durationText(time);
  const durationWords = known ? durationText(look.duration!) : "";
  const level = look.muted ? 0 : look.volume;
  const quiet = look.muted || look.volume === 0;
  return <div data-video-controls className={cn(viewerPill, videoControlRowHeight, "@container/media-row mt-2 w-full max-w-lg flex-none", className)}>
    <Button type="button" variant="quiet" size="icon" data-video-play aria-label={look.paused ? t("imageSlider.play") : t("imageSlider.pause")}
      onClick={act.toggle} className={viewerButton}><Icon name={look.paused ? "play" : "pause"} /></Button>
    {/* The length joins once the video knows it (until then the seek waits; no made-up 0:00). A row under 320px
        (a 320px phone) keeps the seek wide enough to drag and says the length only to a screen reader. */}
    <span data-video-time className="flex-none px-1 whitespace-nowrap tabular-nums">
      {timeWords}{known && <span className="text-white/70 tightrow:hidden"> / {durationWords}</span>}
    </span>
    <input type="range" data-video-seek aria-label={t("imageSlider.seek")} aria-valuetext={known ? `${timeWords} / ${durationWords}` : timeWords}
      min={0} max={known ? look.duration : 0} step="any" value={known ? time : 0} disabled={!known}
      style={{ "--played": `${known && look.duration ? (time / look.duration) * 100 : 0}%` } as CSSProperties}
      onPointerDown={focusRange} onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        act.seek(time + (event.key === "ArrowRight" ? 5 : -5));
      }}
      onChange={event => act.seek(Number(event.currentTarget.value))} className="media-range mx-1 min-w-0 flex-1" />
    <Button type="button" variant="quiet" size="icon" data-video-mute aria-label={quiet ? t("imageSlider.unmute") : t("imageSlider.mute")}
      aria-pressed={quiet} onClick={act.toggleMute} className={viewerButton}>
      <Icon name={quiet ? "muted" : "sound"} /></Button>
    {/* A phone's width keeps the mute button alone, as the browser's own phone controls do; the device sets the level. */}
    {look.volumeSettable && <input type="range" data-video-volume aria-label={t("imageSlider.volume")} aria-valuetext={`${Math.round(level * 100)}%`}
      min={0} max={1} step={0.05} value={level} style={{ "--played": `${level * 100}%` } as CSSProperties}
      onPointerDown={focusRange} onChange={event => act.setVolume(Number(event.currentTarget.value))} className="media-range mr-1 w-20 flex-none narrow:hidden" />}
    <VideoSpeed speed={look.speed} choose={act.setSpeed} className="min-h-11 min-w-11 flex-none px-1" />
    <Button type="button" variant="quiet" size="icon" data-video-full aria-label={t("imageSlider.fullScreen")} onClick={act.fullScreen} className={viewerButton}>
      <Icon name="expand" /></Button>
  </div>;
}
