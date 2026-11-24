import { useTranslation } from "react-i18next";
import type { RunStep } from "@alpacawork/contract/run";
import { cn } from "@/lib/utils";

/** The names agents' tools go by, said as one short family name whichever agent ran them. */
const TOOL_NAMES: Record<string, string> = { command_execution: "Bash", file_change: "Edit", web_search: "WebSearch", mcp_tool_call: "MCP", collab_tool_call: "Agent" };
const toolName = (tool: string) => TOOL_NAMES[tool] ?? (tool.startsWith("mcp__") ? tool.split("__").slice(1).join(".") : tool);
/** A file's name is at the end of its path: cut short, these lose their start. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "file_change"]);
/** What came back says something of these alone (a command's output, what a search found); a read file's first line does not. */
const RESULT_TOOLS = new Set(["Bash", "command_execution", "Grep", "Glob"]);

/**
 * An agent's latest steps as its own tool calls say them: the tool and what it ran, read or searched. `brief` keeps
 * each step to one line (the agent's own words for it when it gave them, as two commands that start alike read apart
 * by those) and shows the last `last` of them; otherwise each step says both, and the first line of what came back.
 * `newestFirst` where the place it stands in reads downward into the past (History); a conversation reads the other way.
 */
export function RunSteps({ steps, brief, last, newestFirst, className }: { steps: readonly RunStep[]; brief: boolean; last?: number; newestFirst?: boolean; className?: string }) {
  const { t } = useTranslation("people");
  const latest = last === undefined ? steps : steps.slice(-last), shown = newestFirst ? [...latest].reverse() : latest;
  if (!shown.length) return null;
  return <ol data-run-steps className={cn("m-0 flex list-none flex-col p-0 text-xs", brief ? "gap-0.5" : "gap-1.5", className)}>
    {shown.map(step => {
      const lines = step.more > 0 ? <span className="flex-none font-sans text-muted">{t("now.step.moreLines", { count: step.more })}</span> : null;
      // Going, done or failed is told by the mark's shape as well as its colour.
      const mark = <span aria-hidden data-run-step-mark className={cn("w-3 flex-none text-center font-sans", step.state === "running" ? "motion-safe:animate-pulse" : step.state === "failed" ? "text-error" : "text-muted")}>
        {step.state === "running" ? <span className="inline-block size-1.5 translate-y-[-1px] rounded-full bg-current" /> : step.state === "failed" ? "✗" : "✓"}</span>;
      const tone = step.state === "running" ? "text-ink" : "text-soft";
      const tool = <span className="flex-none font-medium">{toolName(step.tool)}</span>;
      if (brief) return <li key={step.id} data-run-step={step.state} className={cn("flex min-w-0 items-baseline gap-1.5", tone)}>
        {mark}{tool}
        {step.about ? <span dir="auto" className="min-w-0 truncate">{step.about}</span>
          : FILE_TOOLS.has(step.tool) ? <span dir="rtl" className="min-w-0 truncate text-left font-mono"><bdi>{step.text}</bdi></span>
          : <><span dir="auto" className="min-w-0 truncate font-mono">{step.text}</span>{lines}</>}
      </li>;
      const result = step.result && (step.state === "failed" || RESULT_TOOLS.has(step.tool)) ? step.result : null;
      return <li key={step.id} data-run-step={step.state} className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-1.5", tone)}>
        {mark}
        <div className="flex min-w-0 items-baseline gap-1.5">{tool}
          {step.about ? <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">{step.about}</span>
            : <span dir="auto" className="line-clamp-3 min-w-0 font-mono [overflow-wrap:anywhere]">{step.text} {lines}</span>}</div>
        {step.about && <div dir="auto" className="col-start-2 line-clamp-3 min-w-0 font-mono [overflow-wrap:anywhere]">{step.text} {lines}</div>}
        {result && <div className="col-start-2 flex min-w-0 items-baseline gap-1.5 text-muted">
          <span aria-hidden className="flex-none">⎿</span>
          <span dir="auto" className="min-w-0 truncate font-mono">{result.text}</span>
          {result.more > 0 && <span className="flex-none">{t("now.step.moreLines", { count: result.more })}</span>}
        </div>}
      </li>;
    })}
  </ol>;
}
