import { useTranslation } from "react-i18next";
import { duration, format, share } from "./format";
import { Section, tip } from "./parts";
import type { TasksView } from "./contract";

type Accepted = TasksView["accepted"]["value"];
type Cause = { key: string; name: string; share: number; value: string; note?: string };

/**
 * The main causes of the span's accepted tasks, per axis, the largest three: for "as you meant", the kinds of fix you
 * asked for (of the fixes labelled); for time, the rounds after the first review and where you were while they waited
 * (of the time from request to acceptance); for tokens, the rounds after the first review (of all their tokens). Each is
 * an analysis answer as it comes; only their shares of the whole they are part of are written here.
 */
export function Causes({ accepted }: { accepted: Accepted }) {
  const { t } = useTranslation("analysis");
  const fixes = accepted.instructions.fixes, fixed = accepted.instructions.kinds.find(kind => kind.kind === "fix")?.count ?? 0;
  const time = accepted.time.review + accepted.time.answer + accepted.time.ai + accepted.time.other;
  const tokens = accepted.rounds.first.tokens + accepted.rounds.later.tokens;
  const top = (causes: Cause[]) => causes.filter(cause => cause.share > 0).sort((a, b) => b.share - a.share).slice(0, 3);
  const axes: { key: string; name: string; of: string; causes: Cause[]; none: string }[] = [
    { key: "meant", name: t("causes.meant"), of: t("causes.ofFixes", { count: fixed }), none: t("causes.noFixes"),
      causes: top(fixes.map(fix => ({ key: fix.kind, name: t(`fix.${fix.kind}`), share: fixed ? fix.count / fixed : 0, value: format("times", fix.count) }))) },
    { key: "time", name: t("causes.time"), of: t("causes.ofTime", { time: duration(time) }), none: t("causes.none"),
      causes: top([
        { key: "later", name: t("causes.later"), share: time ? accepted.rounds.later.ms / time : 0, value: duration(accepted.rounds.later.ms), note: t("causes.laterTip") },
        { key: "away", name: t("causes.away"), share: time ? accepted.waits.away / time : 0, value: duration(accepted.waits.away), note: t("waits.awayTip") },
        { key: "otherTasks", name: t("causes.otherTasks"), share: time ? accepted.waits.otherTasks / time : 0, value: duration(accepted.waits.otherTasks), note: t("waits.otherTasksTip") },
        { key: "thisTask", name: t("causes.thisTask"), share: time ? accepted.waits.thisTask / time : 0, value: duration(accepted.waits.thisTask), note: t("waits.thisTaskTip") },
      ]) },
    { key: "tokens", name: t("causes.tokens"), of: t("causes.ofTokens", { tokens: format("tokens", tokens) }), none: t("causes.none"),
      causes: top([{ key: "later", name: t("causes.later"), share: tokens ? accepted.rounds.later.tokens / tokens : 0, value: format("tokens", accepted.rounds.later.tokens),
        note: t("causes.laterTip") }]) },
  ];
  return <Section title={t("causes.title")}>
    <div data-causes="" className="grid grid-cols-3 gap-x-8 gap-y-8 narrow:grid-cols-1">
      {axes.map(axis => <div key={axis.key} className="min-w-0">
        <h3 className="font-semibold">{axis.name}</h3>
        <p className="mb-2 text-xs text-soft">{axis.of}</p>
        {axis.causes.length ? <ul className="divide-y divide-rule border-y border-rule">{axis.causes.map(cause =>
          <li key={cause.key} className="py-2" {...cause.note ? tip(cause.note) : {}} data-tip-tap={cause.note ? "" : undefined}>
            <p className="flex items-baseline gap-2"><span className="me-auto font-semibold">{cause.name}</span>
              <span className="text-xs text-muted tabular-nums">{cause.value}</span><b className="w-10 text-end font-semibold tabular-nums">{share(cause.share)}</b></p>
            <span className="mt-1 block h-1 rounded-xs bg-rule"><i style={{ width: `${Math.round(cause.share * 100)}%` }} className="block h-full rounded-xs bg-reworked" /></span>
          </li>)}</ul>
          : <p className="text-soft">{axis.none}</p>}
      </div>)}
    </div>
  </Section>;
}
