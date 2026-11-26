import { useTranslation } from "react-i18next";
import { ReadFailure } from "@/components/ui/loadable";
import { useViewStore } from "@/state/view-store";
import { format } from "./format";
import { useBreakdown } from "./data";
import { Seg, useChoices, type CallsBy } from "./parts";
import { nameParts, type NamePart } from "./series";
import type { Bin, PartItem, RowSay } from "./rows";
import type { Bucket, UsageView } from "./contract";
import type { Span } from "./place";
import type { Open } from "./TasksLook";

/**
 * The skills, tools or MCP the AI used, as a row of the use's chart like the launches: each bin stacked by name (the five
 * most counted over the chart's days in the models' colours, the rest one grey part), the span's names on the left.
 * The numbers are the server's breakdown by that axis (`analysis breakdown --look usage`), read for this row alone.
 * They are counted from the day counting began (`since`): the bins before it lie hatched, and a span wholly before it
 * has no record. A skill counts once for each launch that used it, so the parts add up to the count beside them.
 */
export function useCalls(bins: Bin[], span: Span, bucket: Bucket, live = true) {
  const { t } = useTranslation("analysis");
  const project = useViewStore(state => state.project);
  const by = useChoices(state => state.callsBy);
  const read = useBreakdown("usage", project, span, bucket, by, live);
  const answer = read.data?.breakdown.look === "usage" ? read.data.breakdown : null;
  // An answer of other bins (another step of time, a span the face has moved on from) is not drawn.
  const series = answer?.series && answer.series.length === bins.length ? answer.series : null;
  const shownBy = (answer?.by ?? by) as CallsBy;
  const since = answer?.since ?? null;
  const { parts, partOf, binParts } = nameParts(answer?.groups ?? []);
  const partName = (part: NamePart, names: number) => part.key === null ? t("usage.otherNames", { count: names }) : part.label;
  const onBin = (at: number) => series?.[at] ? binParts(series[at]!.counts) : [];
  const share = (value: number, all: number) => all ? `${Math.round(value / all * 100)}%` : "";
  const spanSums = parts.map(() => 0), spanNames = parts.map(() => 0);
  for (const row of answer?.rows ?? []) {
    const part = partOf(row.key);
    if (part !== undefined && row.calls) { spanSums[part]! += row.calls; spanNames[part]!++; }
  }
  const total = answer?.counted?.value.calls ?? 0;
  return {
    by: shownBy, since, series, current: !!answer && answer.by === by && !read.isPlaceholderData,
    name: t(shownBy === "skill" ? "usage.skillUses" : shownBy === "tool" ? "usage.toolCalls" : "usage.mcpCalls"),
    total, previous: answer?.counted?.previous?.calls ?? null,
    failure: read.isError ? { error: read.error, retry: () => void read.refetch() } : null,
    /** A bin's parts with counts, in the order they stack. */
    parts: onBin,
    /** The span's parts on the left, each opening the tasks that used that name; the grey rest opens nothing. */
    spanParts: (open: Open): PartItem[] => parts.flatMap((part, at) => spanSums[at]! > 0 ? [{
      color: part.color, name: partName(part, spanNames[at]!),
      value: <b className="font-semibold tabular-nums">{format("times", spanSums[at]!)}</b>, share: share(spanSums[at]!, total),
      onOpen: part.key === null ? undefined : () => open({ set: "used", value: "calls", group: shownBy, member: part.key }),
    }] : []),
    partName,
  };
}
export type Calls = ReturnType<typeof useCalls>;

/** What the calls row says of a bin: its count (or that it was not counted yet), and its names by colour. */
export function callsSay(calls: Calls, notCounted: string): RowSay {
  const share = (value: number, all: number) => all ? `${Math.round(value / all * 100)}%` : "";
  return {
    name: calls.name,
    total: at => calls.series?.[at] ? format("times", calls.series[at]!.calls) : notCounted,
    parts: at => calls.parts(at).map(({ part, value, names }) => ({
      color: part.color, name: calls.partName(part, names), value: format("times", value), share: share(value, calls.series![at]!.calls),
      list: part.key === null ? undefined : (bin: Bin) => ({ set: "used" as const, value: "calls" as const, group: calls.by, member: part.key, from: bin.from, to: bin.to }),
    })),
    // A bin before counting began has no tasks to open.
    list: (bin, at) => !calls.series?.[at] ? null : { set: "used", value: "calls", group: calls.by, member: null, from: bin.from, to: bin.to },
  };
}

/** Which the row counts: skills, tools or MCP; and a read that failed, with a way to ask again. */
export function CallsControls({ calls }: { calls: Calls }) {
  const { t } = useTranslation("analysis");
  const by = useChoices(state => state.callsBy), choose = useChoices(state => state.choose);
  return <div className="mt-3 flex flex-col gap-2">
    <Seg label={t("usage.callsWhat")} value={by} onChange={(next: CallsBy) => choose({ callsBy: next })}
      items={(["skill", "tool", "mcp"] as const).map(key => [key, t(`usage.by.${key}`)] as const)} />
    {calls.failure && <ReadFailure error={calls.failure.error} retry={calls.failure.retry} />}
  </div>;
}
