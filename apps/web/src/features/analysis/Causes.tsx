import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { duration, format, share } from "./format";
import { OPEN, OpenMark, Section, tip } from "./parts";
import type { TasksView } from "./contract";
import type { Open } from "./TasksLook";

type Accepted = TasksView["accepted"]["value"];
/** One cause: its name, its size and its share of the axis's whole (or its bar's length), and the tasks it opens. */
type Cause = { key: string; name: string; value: string; share: number | null; bar: number; note?: string; open?: Parameters<Open>[0] };

/**
 * The main causes of the span's accepted tasks, one column per axis, the largest three first. As you meant: the kinds of
 * fix you asked for (one fix may name several kinds, so they are counted, not shared), then how your questions were
 * answered. Time: where the time from request to acceptance went (parts that do not overlap), and under it how much of
 * it the rounds after the first review took. Tokens: the first review round and the rounds after it. Every number is
 * an analysis answer as it comes; only its share of the whole it is part of is written here. A row whose number a list
 * holds opens those tasks, most first.
 */
export function Causes({ accepted, open }: { accepted: Accepted; open: Open }) {
  const { t } = useTranslation("analysis");
  const { fixes } = accepted.instructions, fixed = accepted.instructions.kinds.find(kind => kind.kind === "fix")?.count ?? 0;
  const time = accepted.time.review + accepted.time.answer + accepted.time.ai + accepted.time.other;
  const tokens = accepted.rounds.first.tokens + accepted.rounds.later.tokens;
  const top = (causes: Cause[]) => causes.filter(cause => cause.bar > 0).sort((a, b) => b.bar - a.bar).slice(0, 3);
  // A row opens its tasks only where a list holds exactly that number (the AI's time, the other time); the waits by where
  // you were, the kinds of fix and the rounds have no list of their own yet.
  const part = (key: string, name: string, ms: number, value: "ai" | "other" | null, note?: string): Cause =>
    ({ key, name, value: duration(ms), share: time ? ms / time : 0, bar: time ? ms / time : 0, note, open: value ? { set: "accepted", value } : undefined });
  const items = accepted.answerItems;
  const ratio = (part: number, whole: number) => whole ? `${share(part / whole)}` : "—";
  const clues = [
    [t("causes.choice"), ratio(items.choice, items.total), t("causes.ofItems", { count: items.total })],
    [t("causes.recommended"), ratio(items.recommended, items.recommendable), t("causes.ofRecommendable", { count: items.recommendable })],
    [t("causes.replaced"), ratio(accepted.questionsReplaced, accepted.questions), t("causes.ofQuestions", { count: accepted.questions })],
    [t("causes.noQuestions"), ratio(accepted.passedNoQuestions, accepted.noQuestions), t("causes.ofTasks", { count: accepted.noQuestions })],
  ] as const;
  const axes: { key: string; name: string; of: string; causes: Cause[]; none: string; after?: React.ReactNode }[] = [
    { key: "meant", name: t("causes.meant"), of: t("causes.ofFixes", { count: fixed }), none: t("causes.noFixes"),
      causes: top(fixes.map(fix => ({ key: fix.kind, name: t(`fix.${fix.kind}`), value: format("tasks", fix.count), share: null,
        bar: fixed ? fix.count / fixed : 0 }))),
      after: <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
        {clues.map(([name, value, base]) => <div key={name} className="contents" {...tip(base)} data-tip-tap="">
          <dt className="text-muted">{name}</dt><dd className="text-end font-semibold tabular-nums">{value}</dd></div>)}
      </dl> },
    { key: "time", name: t("causes.time"), of: t("causes.ofTime", { time: duration(time) }), none: t("causes.none"),
      causes: top([
        part("away", t("waits.away"), accepted.waits.away, null, t("waits.awayTip")),
        part("otherTasks", t("waits.otherTasks"), accepted.waits.otherTasks, null, t("waits.otherTasksTip")),
        part("thisTask", t("waits.thisTask"), accepted.waits.thisTask, null, t("waits.thisTaskTip")),
        part("ai", t("time.ai"), accepted.time.ai, "ai"), part("other", t("time.other"), accepted.time.other, "other"),
      ]),
      after: time > 0 && <p className="mt-3 text-xs text-muted" {...tip(t("causes.laterTip"))} data-tip-tap="">
        {t("causes.laterTime", { total: duration(time), time: duration(accepted.rounds.later.ms), share: share(accepted.rounds.later.ms / time) })}</p> },
    { key: "tokens", name: t("causes.tokens"), of: t("causes.ofTokens", { tokens: format("tokens", tokens) }), none: t("causes.none"),
      causes: [["first", accepted.rounds.first.tokens], ["later", accepted.rounds.later.tokens]].filter(([, n]) => (n as number) > 0).map(([key, n]) => ({
        key: key as string, name: t(`causes.${key}Round`), value: format("tokens", n as number), share: (n as number) / tokens, bar: (n as number) / tokens,
        note: t(`causes.${key}RoundTip`) })) },
  ];
  return <Section title={t("causes.title")}>
    <div data-causes="" className="grid grid-cols-3 gap-x-8 gap-y-8 narrow:grid-cols-1">
      {axes.map(axis => <div key={axis.key} className="min-w-0">
        <h3 className="font-semibold">{axis.name}</h3>
        <p className="mb-2 text-xs text-soft">{axis.of}</p>
        {axis.causes.length ? <ul className="divide-y divide-rule border-y border-rule">{axis.causes.map(cause =>
          <li key={cause.key}><button type="button" disabled={!cause.open} onClick={() => cause.open && open(cause.open)} {...cause.note ? tip(cause.note) : {}}
            className={cn("block w-full rounded-sm py-2 text-start", cause.open && "hover:bg-hover")}>
            <span className="flex items-baseline gap-2"><span className="me-auto font-semibold">{cause.name}</span>
              <span className="text-xs text-muted tabular-nums">{cause.value}</span>
              {cause.share !== null && <b className="w-10 text-end font-semibold tabular-nums">{share(cause.share)}</b>}
              {cause.open && <span className={cn(OPEN, "mx-0 px-0")}><OpenMark /></span>}</span>
            <span className="mt-1 block h-1 rounded-xs bg-rule"><i style={{ width: `${Math.round(cause.bar * 100)}%` }} className="block h-full rounded-xs bg-reworked" /></span>
          </button></li>)}</ul>
          : <p className="text-soft">{axis.none}</p>}
        {axis.after}
      </div>)}
    </div>
  </Section>;
}
