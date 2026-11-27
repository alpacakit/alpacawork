import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import icon from "../../../public/icons/icon-192-2c.png?inline";
import { Icon, shareIcon } from "@/components/ui/icon";
import { TAB, TabLabel } from "@/components/ui/tabs";
import { deviceValue, jsonCodec, useDeviceValue } from "@/lib/device-storage";
import { srgb } from "@/lib/mermaid-colors";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { appliedTheme } from "@/state/theme";
import { useViewStore } from "@/state/view-store";
import { CARD_DEFAULT, CARD_LIMIT, HEROES, NUMBERS, canPick, cardFacts, cardFileName, cardInput, cardLabel, cardPicks, cardPostText, cardWords, pick, type CardChoice, type Hero } from "./card";
import { drawCard, type CardLook, type CardPalette } from "./card-draw";
import { CardPreview, CardSkeleton } from "./CardPreview";
import { CARD_H, CARD_W } from "./card-size";
import { answerOf, type useCardReads } from "./data";
import { Seg } from "./parts";
import { CARD_PERIODS, type AnalysisPlace } from "./place";

type Theme = "dark" | "light";
/** A choice a finger's height on a phone: one of a row of them, or the row's own buttons. */
const TALL = "narrow:h-10", TALL_ROW = "narrow:[&>button]:h-10";
const THEMES: Theme[] = ["dark", "light"];

/** The person's choices for their card, the same the next time it opens on this device. */
const isChoice = (value: unknown): CardChoice | null => {
  if (!value || typeof value !== "object") return null;
  const { hero, numbers, grass, theme } = value as Record<string, unknown>;
  if (!HEROES.some(each => each === hero) || !Array.isArray(numbers) || typeof grass !== "boolean" || !(theme === null || theme === "dark" || theme === "light")) return null;
  return { hero: hero as Hero, numbers: NUMBERS.filter(each => numbers.includes(each)), grass, theme };
};
const cardChoice = deviceValue("alpacawork.shareCard", jsonCodec(isChoice), CARD_DEFAULT);

/** What the card's colours are read from: each theme's tokens (tokens.css) on a part of the page that takes that theme. */
const PROBE = ["bg-bg", "text-ink", "text-muted", "bg-line", "bg-grass-0", "bg-grass-1", "bg-grass-2", "bg-grass-3", "bg-done"] as const;
function readPalette(box: HTMLElement): CardPalette {
  const [bg, ink, muted, line, ...grass] = PROBE.map(name => {
    const style = getComputedStyle(box.querySelector(`[data-token="${name}"]`)!);
    return srgb(name.startsWith("text-") ? style.color : style.backgroundColor, document);
  });
  return { bg: bg!, ink: ink!, muted: muted!, line: line!, grass: grass as CardPalette["grass"] };
}
/** Text widths, and where their glyphs are drawn, in the card's font, by the page's own measure. */
function measurer(font: string): Pick<CardLook, "measure" | "ink"> {
  const context = document.createElement("canvas").getContext("2d");
  const read = (words: string, size: number, weight: number) => {
    if (!context) return null;
    context.font = `${weight} ${size}px ${font}`;
    return context.measureText(words);
  };
  return {
    measure: (words, size, weight) => read(words, size, weight)?.width ?? words.length * size * 0.6,
    ink: (words, size, weight) => {
      const metrics = read(words, size, weight);
      return { left: -(metrics?.actualBoundingBoxLeft ?? 0), ascent: metrics?.actualBoundingBoxAscent ?? size * 0.72, descent: metrics?.actualBoundingBoxDescent ?? 0 };
    },
  };
}

/** The card, drawn to a PNG twice its size: in the browser, sent nowhere. It is read as a data URL, the one kind of
 * picture besides the page's own that the page's policy lets it load. */
function cardPng(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = CARD_W * 2; canvas.height = CARD_H * 2;
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The card could not be drawn")), "image/png");
    };
    image.onerror = () => reject(new Error("The card could not be drawn"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
/** The picture onto the clipboard; the PNG is handed over as it is drawn (Safari takes it only so). */
const canCopyPictures = () => typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write;
async function copyCard(svg: string): Promise<void> {
  if (!canCopyPictures()) throw new Error("No clipboard for pictures");
  return navigator.clipboard.write([new ClipboardItem({ "image/png": cardPng(svg) })]);
}
const canShareFiles = () => {
  try { return !!navigator.canShare?.({ files: [new File([""], "card.png", { type: "image/png" })] }); } catch { return false; }
};
/**
 * Where a post can start with the card's own words (the person's to change): each service's own link to its post screen.
 * None takes a picture by link, so the picture goes along on the clipboard (or into the downloads) to be pasted in.
 * Each mark is the service's own, unaltered, on its own colour or in the button's text colour (X's and Threads' are
 * black or white by their guides; Bluesky's butterfly is white on its blue).
 */
const DESTINATIONS = [
  { key: "x", name: "X", post: (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
    face: "bg-scrim text-paper dark:bg-paper dark:text-scrim",
    mark: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" },
  { key: "bluesky", name: "Bluesky", post: (text: string) => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`,
    face: "bg-[#1185fe] text-white",
    mark: "M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026" },
  { key: "threads", name: "Threads", post: (text: string) => `https://www.threads.com/intent/post?text=${encodeURIComponent(text)}`,
    face: "bg-scrim text-paper dark:bg-paper dark:text-scrim",
    mark: "M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z" },
] as const;
type Destination = typeof DESTINATIONS[number];

/**
 * One way out of the page, as a phone's share sheet lays them out: a round face over its name, the whole column pressed.
 * The services stand on their own colours; what stays on this device (the share menu, copy, save) on the page's.
 */
/** What stays on this device: the page's own ground, its line round it. */
const DEVICE = "border border-line text-ink group-hover:bg-hover";

function Way({ name, label, face, disabled, onClick, describedBy, children }: {
  name: string; label?: string; face: string; disabled: boolean; onClick: () => void; describedBy?: string; children: ReactNode;
}) {
  return <button type="button" disabled={disabled} onClick={onClick} aria-label={label} aria-describedby={describedBy}
    className="group flex w-16 flex-none cursor-pointer touch-manipulation flex-col items-center gap-1.5 rounded-md py-1 text-xs text-muted outline-offset-2 hover:text-ink disabled:cursor-default disabled:opacity-38 disabled:hover:text-muted narrow:w-auto narrow:min-w-0 narrow:flex-1">
    <span className={cn("grid size-12 place-items-center rounded-full narrow:size-11 transition-[filter,transform] group-hover:brightness-110 group-active:translate-y-px group-disabled:brightness-100", face)}>{children}</span>
    <span className="text-center [word-break:keep-all]">{name}</span>
  </button>;
}

/** A press on a service: where it goes, its post screen, what became of the picture (null while it is on its way), and when. */
type Leaving = { to: Destination; url: string; picture: "copied" | "saved" | "lost" | null; at: number };
/** How long what became of the picture stands before the service opens: read in that time, and within the few seconds a
 *  browser still counts the press as the person's (Chrome and Firefox: 5), so the tab is not taken for a pop-up. */
const LEAD_SECONDS = 3;

/**
 * What the press did, standing where the hint was: the picture copied (or saved), then, once that is known, the service
 * opening in a few seconds, with a line running down, a way to open it now and a way not to. It stays after the tab
 * opens, saying what to do there, until it is closed. The service is opened by hand instead where the picture could not
 * be made, and where the browser no longer counts the press as the person's (Safari counts it only for a moment), so
 * the tab is not stopped as a pop-up.
 */
function PostLead({ leaving: { to, url, picture }, done }: { leaving: Leaving; done: () => void }) {
  const { t } = useTranslation("analysis");
  const [left, setLeft] = useState(LEAD_SECONDS);
  const [phase, setPhase] = useState<"counting" | "byHand" | "opened">("counting");
  const counting = phase === "counting" && (picture === "copied" || picture === "saved");
  const open = () => {
    const tab = window.open(url, "_blank");
    if (!tab) { setPhase("byHand"); return; }
    try { tab.opener = null; } catch { /* Already gone elsewhere: nothing of this page stays reachable from it. */ }
    setPhase("opened");
  };
  const opener = useRef(open);
  opener.current = open;
  useEffect(() => { if (picture === "lost") setPhase("byHand"); }, [picture]);
  useEffect(() => {
    if (!counting) return;
    if (navigator.userActivation && !navigator.userActivation.isActive) { setPhase("byHand"); return; }
    if (left <= 0) { opener.current(); return; }
    const tick = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(tick);
  }, [left, counting]);
  const said = picture === "copied" ? t("card.postCopied", { name: to.name }) : picture === "saved" ? t("card.postSave", { name: to.name })
    : picture === "lost" ? t("card.drawFailed") : t("card.postPreparing");
  const quiet = "rounded-sm px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink narrow:min-h-10 narrow:px-3";
  // The time left runs down as a line along the foot of the box, so the words and the two ways keep one line even on a
  // phone. Only what became of the picture is read out; the seconds are not read each time they change.
  return <div className="relative mt-3 grid gap-1.5 overflow-hidden rounded-md border border-line px-3 pt-2.5 pb-2">
    <p role="status" className="flex items-start gap-2 text-sm text-ink">
      {picture === "copied" || picture === "saved" ? <Icon name="check" className="mt-0.5 size-4 flex-none" /> : null}{said}</p>
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {phase === "byHand" && picture !== null
        ? <button type="button" onClick={open} className="me-auto rounded-sm bg-scrim px-3 py-1 text-xs font-semibold text-paper dark:bg-paper dark:text-scrim narrow:min-h-10">{t("card.postOpen", { name: to.name })}</button>
        : phase === "opened" ? <span className="me-auto" />
          : <>
            <span aria-hidden className="me-auto text-xs text-muted tabular-nums">{t("card.postOpensIn", { name: to.name, count: Math.max(left, 1) })}</span>
            <button type="button" onClick={open} disabled={picture === null} className={cn(quiet, "disabled:opacity-38")}>{t("card.postOpenNow")}</button>
          </>}
      <button type="button" onClick={done} className={quiet}>{phase === "opened" ? t("card.postClose") : t("card.postCancel")}</button>
    </div>
    {counting && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink motion-reduce:hidden motion-safe:animate-lead" style={{ animationDuration: `${LEAD_SECONDS}s` }} />}
  </div>;
}

/**
 * The card over the analysis: the picture as it is saved, the ways out of the page (each only when pressed), then what
 * it shows: the span, the number leading, those under it, its colours. The numbers are the analysis commands' for the
 * card's span and the project in view (the project is not on the card).
 */
export function CardPane({ place, reads: { face, tasks, usage }, waitFrom }: {
  place: AnalysisPlace;
  reads: ReturnType<typeof useCardReads>;
  waitFrom: number;
}) {
  const { t, i18n } = useTranslation("analysis");
  const card = place.card!;
  const choice = useDeviceValue(cardChoice);
  const choose = (next: Partial<CardChoice>) => cardChoice.set({ ...choice, ...next });
  const [appTheme] = useState<Theme>(() => appliedTheme(document));
  const theme = choice.theme ?? appTheme;
  const probe = useRef<HTMLDivElement>(null);
  const [looks, setLooks] = useState<Record<Theme, CardLook> | null>(null);
  useLayoutEffect(() => {
    const box = probe.current;
    if (!box) return;
    const font = getComputedStyle(box).fontFamily, gauges = measurer(font);
    setLooks(Object.fromEntries(THEMES.map(each => [each, { palette: readPalette(box.querySelector<HTMLElement>(`.theme-${each}`)!), font, icon, ...gauges }])) as Record<Theme, CardLook>);
  }, []);
  const tasksAnswer = answerOf(tasks), usageAnswer = answerOf(usage);
  const facts = useMemo(() => cardFacts(face, tasksAnswer, usageAnswer),
    [face?.data, face?.current, tasksAnswer?.data, tasksAnswer?.current, usageAnswer?.data, usageAnswer?.current]);
  // The card is written in the screen's language, so a change of language while it is open writes it again: the
  // picture, the words it is read aloud by and the post's sentence then say the same.
  const language = i18n.resolvedLanguage;
  const input = useMemo(() => facts ? cardInput(facts, choice) : null, [facts, choice, language]);
  const svg = useMemo(() => input && looks ? drawCard(input, looks[theme]) : null, [input, looks, theme]);
  const current = !!svg;
  const picks = facts ? cardPicks(choice, facts) : null;
  const [sharing] = useState(canShareFiles);
  const [copying] = useState(canCopyPictures);
  const postHint = useId();
  // As the analysis says it: what failed, no record for these days, or a wait.
  const failed = tasks.error ?? usage.error;
  const state = svg ? null : failed ? <p className="text-soft">{failed.message}</p>
    : facts === null ? <p className="text-soft">{t("usage.none")}</p> : <CardSkeleton waitFrom={waitFrom} />;

  const drawn = async () => facts && svg ? { name: cardFileName(facts), png: await cardPng(svg) } : null;
  /** Saves the picture into the downloads; says so, or that it failed, with toasts, or says nothing when the caller (a post,
   *  which says it in its own box) passes null. */
  const save = async (message: string | null = t("card.saved")) => {
    try {
      const picture = await drawn();
      if (!picture) return false;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(picture.png);
      link.download = picture.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      if (message) notify.success(message);
      return true;
    } catch { if (message !== null) notify.error(t("card.drawFailed")); return false; }
  };
  const copy = () => { if (svg) copyCard(svg).then(() => notify.success(t("card.copied")), () => notify.error(t("card.copyFailed"))); };
  const share = async () => {
    try {
      const picture = await drawn();
      // The card's sentence goes along too, for the apps that take words beside a picture (those that do not drop it).
      if (picture && facts) await navigator.share({ files: [new File([picture.png], picture.name, { type: "image/png" })], text: cardPostText(facts, choice, card.length === "all") });
    } catch (error) {
      // Closed by the person: nothing to say.
      if (!(error instanceof DOMException && error.name === "AbortError")) notify.error(t("card.shareFailed"));
    }
  };
  // The picture goes with the person to the service: onto the clipboard while the press still counts, or, where this
  // browser cannot copy a picture, into their downloads (and there too should a copy still fail). The post opens a
  // moment later (PostLead), so what happened to the picture is read here before the service's tab covers the page.
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const post = (to: Destination) => {
    if (!svg || !facts) return;
    const lead: Leaving = { to, url: to.post(cardPostText(facts, choice, card.length === "all")), picture: null, at: Date.now() };
    setLeaving(lead);
    const settle = (picture: Leaving["picture"]) => setLeaving(now => now?.at === lead.at ? { ...now, picture } : now);
    const saveForPost = () => void save(null).then(saved => settle(saved ? "saved" : "lost"));
    if (copying) void copyCard(svg).then(() => settle("copied"), saveForPost);
    else saveForPost();
  };

  // A number is chosen by the name the card gives it; several can be, so each chosen one carries a check.
  const chip = (key: string, name: string, on: boolean, enabled: boolean, press: () => void, className?: string) =>
    <button key={key} type="button" aria-pressed={on} disabled={!enabled} onClick={press}
      className={cn(TAB, TALL, className, "text-base aria-pressed:bg-tab-shown aria-pressed:font-semibold aria-pressed:text-ink disabled:cursor-default disabled:opacity-38 disabled:hover:text-muted")}>
      {on && <Icon name="check" className="-ms-0.5 size-3" />}<TabLabel>{name}</TabLabel></button>;
  // The names stand in a column as wide as the longest of them, each on one line; on a phone each over its choices.
  // Each choice under its name, the name small and quiet as a section's is, so the choices lead.
  const row = (label: string, body: ReactNode) => <div className="min-w-0">
    <h4 className="mb-1 text-xs font-normal text-soft">{label}</h4>{body}</div>;
  // Choices stand 8px apart, so each reads as its own; a longer language folds onto the next line rather than running
  // past the window. On a phone each is a finger's height.
  const fold = `flex-wrap gap-2 overflow-x-visible ${TALL_ROW}`;

  // The window comes in with its own motion; the picture already standing in its place while this part loads stays still.
  return <div className="pb-6">
    {/* The colours the card is drawn in, one part of the page in each theme. */}
    <div ref={probe} hidden className="font-sans">
      {THEMES.map(each => <div key={each} className={`theme-${each}`}>{PROBE.map(name => <i key={name} data-token={name} className={name} />)}</div>)}
    </div>
    <CardPreview picture={svg && input ? { svg, label: cardWords(input) } : undefined}>{state}</CardPreview>
    {/* The services first, then what stays on this device, apart by a rule; one line under them says what a service's
        press does. On a phone the ways share the width. */}
    <div className="mt-5 flex items-start gap-2 narrow:gap-0">
      {DESTINATIONS.map(each => <Way key={each.key} name={each.name} label={t("card.postTo", { name: each.name })} face={each.face}
        disabled={!current} onClick={() => post(each)} describedBy={postHint}>
        <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="currentColor"><path d={each.mark} /></svg></Way>)}
      <span aria-hidden className="mx-2 mt-3 h-6 w-px flex-none bg-line narrow:mx-1" />
      {sharing && <Way name={t("card.more")} face={DEVICE} disabled={!current} onClick={() => void share()}><Icon name={shareIcon()} className="size-5" /></Way>}
      <Way name={t("card.copy")} face={DEVICE} disabled={!current} onClick={copy}><Icon name="copy" className="size-5" /></Way>
      <Way name={t("card.save")} face={DEVICE} disabled={!current} onClick={() => void save()}><Icon name="download" className="size-5" /></Way>
    </div>
    {leaving ? <PostLead key={leaving.at} leaving={leaving} done={() => setLeaving(null)} />
      : <p id={postHint} className="mt-2 text-xs text-muted">{copying ? t("card.postHintCopy") : t("card.postHintSave")}</p>}
    <div className="mt-8 grid gap-6">
      {row(t("period.label"), <Seg label={t("period.label")} value={card.length} className={fold}
        onChange={length => useViewStore.getState().showAnalysis({ ...place, card: { ...card, length } })}
        items={CARD_PERIODS.map(each => [each, t(`period.${each}`)] as const)} />)}
      {row(t("card.hero"), <Seg label={t("card.hero")} value={picks?.hero ?? choice.hero} onChange={hero => choose({ hero })} className={fold}
        disabled={facts && facts.share === null ? ["share"] : []} items={HEROES.map(key => [key, cardLabel(key)] as const)} />)}
      {row(t("card.numbers", { limit: CARD_LIMIT }), <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The calendar is not one of the numbers counted against the limit: it stands twice as far off, the room kept
            after the last number, so where it begins a line it starts on the same edge as the others. */}
        {NUMBERS.filter(key => key !== picks?.hero).map((key, at, shown) => chip(key, cardLabel(key), !!picks?.rest.includes(key), !!facts && canPick(choice, facts, key),
          () => facts && cardChoice.set(pick(choice, facts, key)), at === shown.length - 1 ? "me-2" : undefined))}
        {chip("grass", t("card.grass"), choice.grass, true, () => choose({ grass: !choice.grass }))}
      </div>)}
      {row(t("card.theme"), <Seg label={t("card.theme")} value={theme} onChange={next => choose({ theme: next })} className={fold}
        items={[["dark", t("card.dark")], ["light", t("card.light")]] as const} />)}
    </div>
  </div>;
}
