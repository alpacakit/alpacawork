---
name: alpacawork-modelchoice
description: An alpacawork add-on. Coordinators and owners working in alpacawork use it when choosing the agent, model and effort for an owner, a member or a reviewer, when the model they would choose cannot run, and when a run on a lighter model or a lower effort shows that the project's assignment table could be cheaper. It keeps that table within its size limit. Skip it outside alpacawork; there, use a general model-choice skill if you have one.
---

# alpacawork-modelchoice (choose from the project's table, try lighter, keep the table short)

These rules are added on top of the alpacawork skill. They turn the project's assignment table into one choice per placement, and they let the table get cheaper over time without growing. This skill does not change the alpacawork skill's guardrails, and the scope of approval follows "Approval defaults" there.

- **Assignment table**: the rows in the project policy that map a kind of work to an agent, a model and an effort, for example `Investigation of a limited scope: claude sonnet, effort medium`. The policy names this skill and keeps the table, its default and fallback lines, and its size limit; this skill keeps the procedure.
- The selectable agents and values are the `params` of agents in `alpacawork config get`. Put the choice in `agent assign --ai-stack` or `task request --selected`, as the alpacawork skill describes.

## 1. Choose

- **Choose by the work's nature, not its name.** Read what the agent will have to judge and what a mistake would cost: how hard the judgment is, how far its effect reaches, how much it must read, and whether a person uses the result directly. The same title can need different rows.
- **One pass through the table.** Read the rows from the top and use the first row whose description fits. The table is written so that a narrower row comes before a broader one; do not combine rows or pick the cheapest of several that fit. A value a row leaves unnamed (often the effort) comes from the table's default line, then from the agent's starting value.
- **No row fits.** Choose the closest row by nature, use it, and in your report propose a new row or a broader wording of an existing one (section 3).
- **Named by the user.** When the user's words (the top task's User instructions included) name the agent, model or effort for this work, use that for the parts they name.
- **It cannot run.** When the chosen model is unavailable (a usage limit, a model removed from the configuration), use the table's fallback line for it. With no fallback line, use another option the same row names, if any; otherwise ask your requester instead of substituting. Name any substitute in your report, and do not move to a weaker model silently.

## 2. Try lighter

- **When.** A piece of work looks like it would pass with one step lighter: the next cheaper model, or the same model at a lower effort. Try one step only, and only where a miss is caught before it reaches anyone (a build that is reviewed, an investigation whose answer is checked).
- **How.** Run the work on the lighter side. Have the side the table names review that result, as a separate placement or the same review the work would get anyway. Do not also run the full work on the named side to compare.
- **Judge.** Lighter passes when the review asks for no large fix: no change of approach, no rework of a large part, no missed requirement. Small wording or detail fixes still count as a pass.
- **Record.** Write in the task's report, in one line, what ran on which side and whether the review needed a large fix. One pass is enough to propose a row; a large fix keeps the table as it is.

## 3. Rewrite the table

- **Propose, do not write.** An owner writes the proposal in the report: the row to add or the row to change, with its new wording and the trial it rests on. The coordinator writes the project policy when the user agrees.
- **Generalize by nature.** Describe the work by its scope, the weight of its judgment and how much it reads, not by the task's title or topic, so the row fits the next task of the same kind. Before adding a row, check whether an existing row can be widened to cover it.
- **Keep the order meaningful.** Place a new row above any broader row it overlaps, so that the first match stays correct.
- **Stay within the limit.** The policy states the table's size limit (lines and characters). Without one, keep the section to 15 bullets and 1500 characters. When an addition would exceed it, first merge rows of similar nature into one general row, then drop supporting notes such as why a row was chosen; the trial reports keep those reasons.
