import { useLayoutEffect, useRef, useState, type Ref, type VideoHTMLAttributes } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { mediaKind, type MediaKind } from "@/domain/task-files";
import { durationText } from "@/lib/media-time";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { VideoControls, VideoSpeed, type VideoControlsLook } from "./VideoControls";
import { notify, recordFailure } from "@/lib/notify";

// Videos and sounds, including portals in the coordinator's document. Independently opened original-file tabs are not Task players.
const taskMedia = new Set<HTMLMediaElement>();
const taskVideos = new Set<HTMLVideoElement>();

/** A person may start another video or sound, but two Task players never play together. */
export function pauseTaskMedia(except?: HTMLMediaElement) {
  taskMedia.forEach(media => {
    if (media !== except) media.pause();
  });
}

// One speed for every Task video in this visit: the next slide, a reopened video and the body's videos all play at
// the speed last chosen, and a reload starts again at 1x. Each video still reads its own speed back to draw it.
let videoSpeed = 1;
function applySpeed(video: HTMLVideoElement) {
  // The default too: the browser resets the speed to it whenever the element loads its source again.
  video.defaultPlaybackRate = videoSpeed;
  video.playbackRate = videoSpeed;
}
// The speed each video last played at: a `ratechange` that moved only its default (a video that refused the speed
// itself) is not a new speed, so a refusing video never hands its old speed back to the others.
const playedSpeed = new WeakMap<HTMLVideoElement, number>();
/**
 * A speed set on any Task video, by this app's control or the browser's own (its full-screen menu), becomes the one
 * speed: every video's `ratechange` comes here. The others already at it write nothing, so the echo stops at once.
 */
function shareSpeed(from: HTMLVideoElement) {
  const speed = from.playbackRate;
  if (playedSpeed.get(from) === speed) return;
  playedSpeed.set(from, speed);
  if (speed === videoSpeed) return;
  videoSpeed = speed;
  taskVideos.forEach(video => {
    if (video.playbackRate === videoSpeed && video.defaultPlaybackRate === videoSpeed) return;
    try { applySpeed(video); } catch (error) { recordFailure(error, "task video speed"); }
  });
}

type TaskVideoProps = VideoHTMLAttributes<HTMLVideoElement> & {
  src: string; viewer?: boolean; startAt?: number; onPositionChange?: (time: number) => void;
  /** The box the native player and its speed share (a file link's margin), outside the viewer. */
  frameClassName?: string;
};
type WebKitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void; webkitExitFullscreen?: () => void; webkitDisplayingFullscreen?: boolean;
};
const initialLook: VideoControlsLook = { paused: true, time: 0, duration: undefined, muted: false, volume: 1, volumeSettable: false, speed: 1 };

/**
 * Native in a file/body/poster; the selected slider opts into a separate control row. A source owns one lifetime.
 * A played video has the same speed control either way: in the slider's row, or over the native player's corner.
 */
export function TaskVideo(props: TaskVideoProps) {
  return <TaskVideoSource key={props.src} {...props} />;
}

function TaskVideoSource({ src, className, frameClassName, controls = true, viewer = false, startAt = 0.001, onPositionChange,
  onLoadedMetadata, onPlay, onError, onClick, ...props }: TaskVideoProps) {
  const { t } = useTranslation("reader");
  const [video, setVideo] = useState<WebKitVideo | null>(null);
  const [failed, setFailed] = useState(false);
  const [look, setLook] = useState(initialLook);
  const [busy, setBusy] = useState(false);
  // What a press on the video comes to when it fails is said as the app says any failure, in the video's window.
  const said = { play: () => t("imageSlider.playFailed"), fullscreen: () => t("imageSlider.fullScreenFailed"), controls: () => t("imageSlider.controlsFailed") };
  const fail = (kind: keyof typeof said, cause?: unknown) => {
    if (cause !== undefined) recordFailure(cause, `task video ${kind}`);
    notify.error(said[kind](), { id: `task-video:${kind}`, from: video });
  };
  const restoreAt = useRef(startAt).current;
  // The viewer keeps only a revisit snapshot; it never writes the live media element's position.
  const remember = useRef(onPositionChange);
  remember.current = onPositionChange;
  // Request lifetime and WebKit's event-only state belong here; `look`/`busy` only render what this element says.
  const life = useRef({ alive: false, request: 0, pending: false, webkit: false, volumeSettable: false });
  const rememberPosition = () => {
    if (video && video.readyState >= 1 && Number.isFinite(video.currentTime)) remember.current?.(video.currentTime);
  };
  const refresh = () => {
    if (!video || !life.current.alive) return;
    const full = life.current.pending || life.current.webkit || video.ownerDocument.fullscreenElement === video;
    video.controls = viewer ? full : controls;
    video.toggleAttribute("data-video-fullscreen", viewer && full);
    rememberPosition();
    setBusy(full);
    const next: VideoControlsLook = { paused: video.paused || video.ended, time: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined,
      muted: video.muted, volume: video.volume, volumeSettable: life.current.volumeSettable, speed: video.playbackRate };
    setLook(before => before.paused === next.paused && before.time === next.time && before.duration === next.duration &&
      before.muted === next.muted && before.volume === next.volume && before.volumeSettable === next.volumeSettable &&
      before.speed === next.speed ? before : next);
  };
  const exitFullscreen = async () => {
    if (!video) return;
    try {
      if (video.ownerDocument.fullscreenElement === video) await video.ownerDocument.exitFullscreen();
      else if (life.current.webkit || video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
    } catch (error) {
      if (life.current.alive) fail("fullscreen", error);
      else recordFailure(error, "task video leaving fullscreen during cleanup");
    }
  };
  useLayoutEffect(() => {
    if (!video) return;
    const state = life.current;
    const at = video.ownerDocument;
    state.alive = true;
    taskVideos.add(video);
    taskMedia.add(video);
    // Probe a disposable element, never the person's playing volume. Some platforms deliberately make this read-only.
    if (viewer) {
      try { const probe = at.createElement("video"); probe.volume = 0.5; state.volumeSettable = probe.volume === 0.5; }
      catch { state.volumeSettable = false; }
    }
    try { applySpeed(video); } catch (error) { recordFailure(error, "task video speed"); }
    playedSpeed.set(video, video.playbackRate);
    const events = viewer ? ["play", "pause", "ended", "timeupdate", "durationchange", "loadedmetadata", "volumechange", "emptied", "seeking", "seeked"] : [];
    events.forEach(name => video.addEventListener(name, refresh));
    const rate = () => { shareSpeed(video); refresh(); };
    video.addEventListener("ratechange", rate);
    const changed = () => { state.pending = false; refresh(); };
    const rejected = () => { state.pending = false; fail("fullscreen"); refresh(); };
    const began = () => { state.webkit = true; state.pending = false; refresh(); };
    const ended = () => { state.webkit = false; state.pending = false; refresh(); };
    if (viewer) {
      at.addEventListener("fullscreenchange", changed);
      video.addEventListener("fullscreenerror", rejected);
      video.addEventListener("webkitbeginfullscreen", began);
      video.addEventListener("webkitendfullscreen", ended);
    }
    const stop = () => { state.request++; video.pause(); };
    at.defaultView?.addEventListener("pagehide", stop);
    refresh();
    return () => {
      void exitFullscreen();
      rememberPosition();
      state.alive = false; state.request++; state.pending = false; state.webkit = false;
      taskVideos.delete(video);
      taskMedia.delete(video);
      at.defaultView?.removeEventListener("pagehide", stop);
      events.forEach(name => video.removeEventListener(name, refresh));
      video.removeEventListener("ratechange", rate);
      at.removeEventListener("fullscreenchange", changed);
      video.removeEventListener("fullscreenerror", rejected);
      video.removeEventListener("webkitbeginfullscreen", began);
      video.removeEventListener("webkitendfullscreen", ended);
      video.pause();
      if (viewer) video.controls = false;
    };
    // Each mounted element/source owns these subscriptions; media events read live values, not a captured render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, viewer, controls]);

  const toggle = async () => {
    if (!video) return;
    const state = life.current;
    const request = ++state.request;
    if (!video.paused && !video.ended) { video.pause(); refresh(); return; }
    try {
      const playing = video.play();
      refresh();
      await playing;
      if (!state.alive || request !== state.request) video.pause();
    } catch (error) {
      if (state.alive && request === state.request) { fail("play", error); refresh(); }
    }
  };
  const fullScreen = async () => {
    if (!video) return;
    const state = life.current;
    if (state.pending || state.webkit || video.ownerDocument.fullscreenElement === video) return;
    state.pending = true;
    refresh(); // Native controls must be ready before the user-activated browser call.
    try {
      if (video.requestFullscreen) await video.requestFullscreen();
      else if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); state.webkit = !!video.webkitDisplayingFullscreen; }
      else throw new Error("Video fullscreen is unavailable");
      if (!state.alive) await exitFullscreen();
    } catch (error) {
      if (state.alive) fail("fullscreen", error);
    } finally { state.pending = false; refresh(); }
  };
  useEscapeLayer(viewer && busy, ESCAPE_LAYER.image + 1, () => {
    void exitFullscreen();
  });
  // Native media events may be queued. Read after a write too, so an immediate second input sees the real value.
  const change = (write: (element: WebKitVideo) => void) => {
    if (!video) return;
    try { write(video); }
    catch (error) { fail("controls", error); } finally { refresh(); }
  };

  if (failed) return controls || viewer
    ? <span data-video-error role="status" className={cn("block text-sm text-muted", className)}>
        {t("image.videoUnavailable", { name: props["aria-label"] ?? src })}
      </span>
    : <span data-video-error aria-hidden="true" className={cn("flex items-center justify-center text-white/70", className)}>
        <Icon name="error" className="size-5" />
      </span>;
  // Changing the speed keeps the position: only the rate is written, never the time. The pressed video's failure is
  // said for it; the others follow from its `ratechange`.
  const setSpeed = (speed: number) => change(element => { element.playbackRate = speed; shareSpeed(element); });
  const player = <video ref={setVideo} data-task-video data-video-fullscreen={viewer && busy ? "" : undefined}
    src={`${src}#t=0.001`} controls={viewer ? busy : controls} playsInline preload="metadata"
    className={className} {...props} onPlay={event => { pauseTaskMedia(event.currentTarget); onPlay?.(event); }}
    onLoadedMetadata={event => {
      if (viewer && Number.isFinite(restoreAt)) change(media => { media.currentTime = Math.max(0, Number.isFinite(media.duration) ? Math.min(restoreAt, media.duration) : restoreAt); });
      onLoadedMetadata?.(event);
      refresh();
    }}
    onClick={event => { if (viewer && !busy) void toggle(); onClick?.(event); }}
    onError={event => { setFailed(true); onError?.(event); }} />;
  if (!viewer) return controls
    ? <span data-video-frame className={cn("relative block w-fit max-w-full", frameClassName)}>{player}
        <VideoSpeed speed={look.speed} choose={setSpeed}
          className="absolute left-2 top-2 z-10 h-7 min-w-11 border border-white/30 bg-scrim/55 px-2 narrow:h-11 narrow:min-w-14" />
      </span>
    : player;
  return <>{player}
    <VideoControls look={look} act={{ toggle: () => { void toggle(); },
      seek: time => change(element => { if (Number.isFinite(element.duration) && element.duration > 0) element.currentTime = Math.max(0, Math.min(time, element.duration)); }),
      toggleMute: () => change(element => { const quiet = element.muted || element.volume === 0; if (quiet && element.volume === 0 && life.current.volumeSettable) element.volume = 1; element.muted = !quiet; }),
      setVolume: volume => change(element => { if (life.current.volumeSettable) { element.volume = Math.max(0, Math.min(volume, 1)); element.muted = false; } }),
      setSpeed, fullScreen: () => { void fullScreen(); } }} />
  </>;
}

/** A still first frame for the file sheet, attachment card, and neighbouring slide. */
export function VideoPoster({ src, className, badge = true, onError }: { src: string; className?: string; badge?: boolean; onError?: () => void }) {
  const [duration, setDuration] = useState<number>();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <span className={cn("relative block overflow-hidden bg-black", className)}>
    <TaskVideo src={src} controls={false} tabIndex={-1} aria-hidden="true" className="size-full object-contain pointer-events-none"
      onLoadedMetadata={event => setDuration(event.currentTarget.duration)} onError={() => { setFailedSrc(src); onError?.(); }} />
    {badge && failedSrc !== src && <span aria-hidden="true" className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-scrim/70 px-1 py-0.5 text-xs leading-none tabular-nums text-white">
      <span>▶</span>{duration !== undefined && Number.isFinite(duration) ? durationText(duration) : null}
    </span>}
  </span>;
}

/** What a media file says when it cannot be shown or played here, by its kind. */
export function mediaUnavailable(t: TFunction<"reader">, kind: MediaKind | null, name: string) {
  return kind === "video" ? t("image.videoUnavailable", { name }) : kind === "audio" ? t("image.audioUnavailable", { name }) : t("image.unavailable", { name });
}

/**
 * A sound: the browser's own player, which every platform draws with play, position and volume. It joins the Task
 * players, so starting it pauses a playing video. `onError` is a source it cannot play (a codec, a broken file).
 */
export function TaskAudio({ src, label, className, onError }: { src: string; label: string; className?: string; onError?: () => void }) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  useLayoutEffect(() => {
    if (!audio) return;
    taskMedia.add(audio);
    const stop = () => audio.pause();
    const view = audio.ownerDocument.defaultView;
    view?.addEventListener("pagehide", stop);
    return () => { taskMedia.delete(audio); view?.removeEventListener("pagehide", stop); audio.pause(); };
  }, [audio]);
  return <audio key={src} ref={setAudio} data-task-audio src={src} controls preload="metadata" aria-label={label}
    className={cn("block w-full max-w-md", className)} onPlay={event => pauseTaskMedia(event.currentTarget)} onError={onError} />;
}

/** A sound's still picture: its mark on a tile, where an image or a video shows a frame. */
export function AudioTile({ className }: { className?: string }) {
  return <span data-audio-tile className={cn("grid place-items-center bg-lit text-muted", className)}><Icon name="sound" className="size-5" /></span>;
}

/** A media file's still picture: a video's first frame, a sound's tile, or the image itself (a report row, a coordinator message). */
export function MediaThumb({ name, src, className, badge }: { name: string; src: string; className?: string; badge?: boolean }) {
  const kind = mediaKind(name);
  return kind === "video"
    ? <VideoPoster src={src} className={className} badge={badge} />
    : kind === "audio" ? <AudioTile className={className} />
    : <img src={src} alt="" loading="lazy" className={cn("object-cover object-left-top", className)} />;
}

/** The small overlay opens a video in the common slider without taking over playback controls. */
export function ExpandVideo({ onClick, className, buttonRef, triggerProps }: {
  onClick: () => void; className?: string; buttonRef?: Ref<HTMLButtonElement>; triggerProps?: Record<string, string | undefined>;
}) {
  const { t } = useTranslation("reader");
  const label = t("imageSlider.expandVideo");
  return <button ref={buttonRef} type="button" aria-label={label} title={label} onClick={onClick} {...triggerProps}
    className={cn("absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-full border border-white/30 bg-scrim/55 text-white narrow:size-11", className)}>
    <Icon name="expand" className="size-4" />
  </button>;
}
