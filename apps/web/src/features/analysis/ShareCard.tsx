import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import icon from "../../../public/icons/icon-192-2c.png?inline";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
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
/** Text widths, and where their first glyph begins, in the card's font, by the page's own measure. */
function measurer(font: string): Pick<CardLook, "measure" | "bearing"> {
  const context = document.createElement("canvas").getContext("2d");
  const read = (words: string, size: number, weight: number) => {
    if (!context) return null;
    context.font = `${weight} ${size}px ${font}`;
    return context.measureText(words);
  };
  return {
    measure: (words, size, weight) => read(words, size, weight)?.width ?? words.length * size * 0.6,
    bearing: (words, size, weight) => -(read(words, size, weight)?.actualBoundingBoxLeft ?? 0),
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
/** X's post screen, its text begun with the card's own words (the person's to change). */
const postUrl = (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/**
 * X's mark as X gives it (its brand toolkit, about.x.com): its own form, unaltered, in one colour, black or white (the button's
 * text, which is pure black or white), with equal room on every side (the button's padding and the gap to its word).
 */
function XMark() {
  return <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 flex-none" fill="currentColor">
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </svg>;
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
  const { t } = useTranslation("analysis");
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
  const input = useMemo(() => facts ? cardInput(facts, choice) : null, [facts, choice]);
  const svg = useMemo(() => input && looks ? drawCard(input, looks[theme]) : null, [input, looks, theme]);
  const current = !!svg;
  const picks = facts ? cardPicks(choice, facts) : null;
  const [sharing] = useState(canShareFiles);
  const [copying] = useState(canCopyPictures);
  // As the analysis says it: what failed, no record for these days, or a wait.
  const failed = tasks.error ?? usage.error;
  const state = svg ? null : failed ? <p className="text-soft">{failed.message}</p>
    : facts === null ? <p className="text-soft">{t("usage.none")}</p> : <CardSkeleton waitFrom={waitFrom} />;

  const drawn = async () => facts && svg ? { name: cardFileName(facts), png: await cardPng(svg) } : null;
  const save = async (message = t("card.saved")) => {
    try {
      const picture = await drawn();
      if (!picture) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(picture.png);
      link.download = picture.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
      notify.success(message);
    } catch { notify.error(t("card.drawFailed")); }
  };
  const copy = () => { if (svg) copyCard(svg).then(() => notify.success(t("card.copied")), () => notify.error(t("card.copyFailed"))); };
  const share = async () => {
    try {
      const picture = await drawn();
      if (picture) await navigator.share({ files: [new File([picture.png], picture.name, { type: "image/png" })] });
    } catch (error) {
      // Closed by the person: nothing to say.
      if (!(error instanceof DOMException && error.name === "AbortError")) notify.error(t("card.shareFailed"));
    }
  };
  // The picture goes with the person to X: onto the clipboard while the press still counts, or, where this browser
  // cannot copy a picture, into their downloads, then the post opens in a new tab. Should a copy still fail, the
  // picture is saved after all, so it is at hand to attach either way.
  const post = () => {
    if (!svg || !facts) return;
    const text = cardPostText(facts, choice, card.length === "all");
    const saveForPost = () => void save(t("card.postSave"));
    if (copying) void copyCard(svg).then(() => notify.success(t("card.postCopied")), saveForPost);
    else saveForPost();
    window.open(postUrl(text), "_blank", "noopener");
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

  return <div className="animate-rise pb-6">
    {/* The colours the card is drawn in, one part of the page in each theme. */}
    <div ref={probe} hidden className="font-sans">
      {THEMES.map(each => <div key={each} className={`theme-${each}`}>{PROBE.map(name => <i key={name} data-token={name} className={name} />)}</div>)}
    </div>
    <CardPreview picture={svg && input ? { svg, label: cardWords(input) } : undefined}>{state}</CardPreview>
    <div className="mt-4 flex flex-wrap items-center gap-2 narrow:[&>button]:min-h-10">
      {/* Opening the X composer leads, black on a light page and white on a dark one. Saving,
          copying and the device's own sharing stand beside it, quieter. */}
      <Button disabled={!current} onClick={post} aria-label={t("card.postOnX")} title={t("card.postOnX")}
        className="min-h-10 gap-2.5 border-scrim bg-scrim px-5 text-base font-semibold text-paper hover:border-scrim hover:bg-scrim hover:text-paper active:translate-y-px dark:border-paper dark:bg-paper dark:text-scrim dark:hover:border-paper dark:hover:bg-paper dark:hover:text-scrim">
        <XMark />{t("card.post")}</Button>
      <Button variant="outline" disabled={!current} onClick={() => void save()} className="active:translate-y-px"><Icon name="download" className="size-3.5" />{t("card.save")}</Button>
      <Button variant="outline" disabled={!current} onClick={copy} className="active:translate-y-px"><Icon name="copy" className="size-3.5" />{t("card.copy")}</Button>
      {sharing && <Button variant="outline" disabled={!current} onClick={() => void share()} className="active:translate-y-px">{t("card.share")}</Button>}
    </div>
    {/* What posting will do with the picture, said before it is pressed. */}
    <p className="mt-2 text-xs text-soft">{copying ? t("card.postHintCopy") : t("card.postHintSave")}</p>
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
