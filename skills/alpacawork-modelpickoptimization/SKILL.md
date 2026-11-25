---
name: alpacawork-modelpickoptimization
description: An alpacawork add-on. Owners and coordinators working in alpacawork use it to make the project's model assignment table cheaper over time: when work looks like it would pass on a lighter model or a lower effort than its row names, when such a trial comes back reviewed, and when proposing a change to the table. It does not cover reading the table to place an agent.
---

# alpacawork-modelpickoptimization (try lighter, then rewrite the table)

These rules are added on top of the alpacawork skill. The project policy keeps an assignment table: rows that map a kind of work to an agent, a model and an effort. This skill is how that table gets cheaper without growing. It does not change the alpacawork skill's guardrails, and the scope of approval follows "Approval defaults" there.

## 1. Try lighter

- **When.** Work looks like it would pass one step lighter than its row: the next cheaper model, or the same model at a lower effort. Try only where a miss is caught before it reaches anyone (a build that is reviewed, an investigation whose answer is checked).
- **How.** Run the work on the lighter side, and have the side the row names review it. Do not also run the full work on the named side to compare.
- **Judge.** The trial passes when the review asks for no large fix: no change of approach, no rework of a large part, no missed requirement.
- **Record.** In the task's report, write in one line what ran on which side and whether the review needed a large fix.

## 2. Rewrite the table

- **Propose, do not write.** After a passing trial, the owner proposes in the report the row to add or change, with its new wording. The coordinator writes the project policy when the user agrees. A trial that needed a large fix leaves the table as it is.
- **Describe the work by its nature.** Write a row by the work's scope, the weight of its judgment and how much it reads, not by a task's title or topic, so it fits the next task of the same kind. Widen an existing row before adding a new one.
- **Keep the first match right.** Agents read the table from the top and use the first row that fits, so place a row above any broader row it overlaps.
- **Stay within the limit.** Keep the section within the limit the policy states (15 lines and 1500 characters if it states none). When an addition would exceed it, merge rows of similar nature into one, then drop supporting notes such as why a row was chosen.
