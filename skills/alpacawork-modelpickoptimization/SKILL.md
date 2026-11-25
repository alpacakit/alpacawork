---
name: alpacawork-modelpickoptimization
description: An alpacawork add-on for making model choices cheaper over time. Owners and coordinators working in alpacawork use it when they place an agent or choose the model for a request and the result will be reviewed before anyone uses it, when such a trial on a lighter model or effort comes back reviewed, and when proposing to add or change a model rule in the project policy. Skip it when the user named the model for this work, and when the result is used without a review (outside effects, deletion, urgent work).
---

# alpacawork-modelpickoptimization (try lighter, then rewrite the model rules)

These rules are added on top of the alpacawork skill. The project policy may list model rules: bullets that map a kind of work to an agent, a model and an effort, read from the top with the first fitting bullet used. This skill is how those rules get cheaper without growing. It does not change the alpacawork skill's guardrails, and the scope of approval follows "Approval defaults" there.

## 1. Start point

- The start point is what the work would get without a trial: the model the user named for this work, else the first fitting model rule, else the default AI in the configuration (the first row of the agents' AI stack, `aiStack`, in `alpacawork config get`).
- When the policy has no model rules, the default AI is the start point for every piece of work. Trials and proposals below work the same way; the first passing trial proposes the first rule.

## 2. Try lighter, or not

- **Try** one step lighter than the start point (the next cheaper model, or the same model at a lower effort) when all of these hold:
  - The work will be reviewed before anyone uses its result (a build that is reviewed, an investigation whose answer is checked).
  - It can wait for a review and, if that fails, a second run.
  - The user did not name the model, and the start point is not already the lightest choice.
  - The start point is not a rule that already names a lighter builder and its reviewer; such a rule is a trial already adopted, so use it as written.
  - No earlier trial of the same kind of work on that lighter side needed a large fix, unless the models offered have changed since.
- **Do not try** otherwise: use the start point as it is, and write nothing about it.
- **How.** Run the work on the lighter side, and have the start point's model review it. Do not also run the full work on the start point to compare.
- **Judge.** The trial passes when the review asks for no large fix: no change of approach, no rework of a large part, no missed requirement.
- **Record.** In the task's report, write in one line what ran on which side and whether the review needed a large fix.

## 3. Rewrite the model rules

- **Propose, do not write.** After a passing trial, the owner proposes in the report the rule to add or change, with its new wording. The coordinator writes the project policy when the user agrees. A trial that needed a large fix leaves the rules as they are.
- **Describe the work by its nature.** Write a rule by the work's scope, the weight of its judgment and how much it reads, not by a task's title or topic, so it fits the next task of the same kind. Widen an existing rule before adding a new one.
- **Keep the first match right.** Place a rule above any broader rule it overlaps.
- **Stay within the limit.** Keep the rules within the limit the policy states (15 bullets and 1500 characters if it states none). When an addition would exceed it, merge rules of similar nature into one, then drop supporting notes such as why a rule was chosen.
