import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { GuideRole } from "./guide-definition";

/**
 * Who does what, drawn in a guide balloon's colours: you → the coordinator, at the conversation and the input → two
 * Tasks, each with its owner, the first with a member beside it. The role the balloon points at is lit (filled), so
 * what is on the screen there and its place in the whole are seen together. The balloon's words say the same, so the
 * picture is hidden from a screen reader. The names are the ones the detail's history shows (reader's party tags).
 */
export function RolesPicture({ lit }: { lit: GuideRole }) {
  const { t } = useTranslation(["tree", "reader"]);
  const name = (role: "you" | "coordinator" | "self" | "member") => t(`reader:reportFeed.row.tag.${role}`);
  const task = <Box lit={lit === "owner"} title={t("tree:guide.roles.task")} under={name("self")} />;
  return <div aria-hidden="true" data-guide-roles={lit} className="flex items-center gap-1.5 py-1.5 pr-2 text-xs">
    <Box title={name("you")} />
    <Line />
    <Box lit={lit === "coordinator"} title={name("coordinator")} under={t("tree:guide.roles.where")} />
    <Branch />
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">{task}<span className="w-2 flex-none border-t border-dashed border-bg/50" /><Box title={name("member")} /></div>
      <div className="flex items-center">{task}</div>
    </div>
  </div>;
}

function Box({ title, under, lit = false }: { title: string; under?: string; lit?: boolean }) {
  return <span className={cn("flex flex-none flex-col items-center rounded-md border px-2 py-1 text-center",
    lit ? "border-bg bg-bg text-ink" : "border-bg/40 text-bg/85")}>
    <span className="text-sm font-semibold whitespace-nowrap">{title}</span>
    {under && <span className={cn("whitespace-nowrap", lit ? "text-muted" : "text-bg/60")}>{under}</span>}
  </span>;
}

/** A short line on to the next box. */
function Line() {
  return <span className="w-3 flex-none border-t border-bg/50" />;
}

/** One line splitting in two, up and down, to the two Tasks. */
function Branch() {
  // As tall as the two Tasks beside it, its ends at the middle of each (a quarter in from either end).
  return <svg viewBox="0 0 16 100" preserveAspectRatio="none" className="w-4 flex-none self-stretch stroke-bg/50" fill="none" strokeWidth={1}>
    <path d="M0 50h6M6 50V25h10M6 50v25h10" vectorEffect="non-scaling-stroke" />
  </svg>;
}
