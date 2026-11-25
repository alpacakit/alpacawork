---
name: alpacawork-modelpickoptimization
description: An alpacawork add-on that optimizes the choice of model and effort over time. Owners and coordinators working in alpacawork use it when they place an agent or choose the model or effort for a request and the result will be reviewed before anyone uses it, when such a trial on a lighter model or effort comes back reviewed, and when proposing to add or change a model rule in the project policy. Skip it when the user named the model or the effort for this work, and when the result is used without a review (outside effects, deletion, urgent work).
---

# alpacawork-modelpickoptimization (optimize the choice of model and effort)

These rules are added on top of the alpacawork skill. The project policy may list model rules: bullets that map a kind of work to an agent, a model and an effort, read from the top with the first fitting bullet used. This skill is how those rules get cheaper, in model and in effort, without growing. It does not change the alpacawork skill's guardrails, and the scope of approval follows "Approval defaults" there.

## 1. Start point

- The start point is the model and effort the work would get without a trial: what the user named for this work, else the first fitting model rule, else the default AI in the configuration (the first row of the agents' AI stack, `aiStack`, in `alpacawork config get`).
- When the policy has no model rules, the default AI is the start point for every piece of work. Trials and proposals below work the same way; the first passing trial proposes the first rule.

## 2. Try lighter, or not

- **Try** one step lighter than the start point when all of these hold. One step is one level lower effort on the same model, or the next cheaper model.
  - The work will be reviewed before anyone uses its result (a build that is reviewed, an investigation whose answer is checked).
  - It can wait for a review and, if that fails, a second run.
  - The user named neither the model nor the effort, and "Which to lower" below finds a step to take.
  - The start point is not a rule that already names a lighter builder and its reviewer; such a rule is a trial already adopted, so use it as written.
  - No earlier trial of the same kind of work on that step needed a large fix, unless the models offered have changed since.
- **Do not try** otherwise: use the start point as it is, and write nothing about it.
- **One step, one change.** Lower either the effort or the model, never both at once, so a failed review shows which one was too light.
- **Which to lower.** Take the first that fits; if neither fits, do not try.
  - **The effort**, when it is not already the model's lowest and the work does not lean on reasoning. It keeps the model's knowledge and instruction following, so it is usually the smaller change. It fits work that is well specified, or mostly reading, searching and tool calls. It does not fit work with many dependent reasoning steps (planning, debugging, a design choice) or a long run on its own, where a low effort skips checks, stops early or reports done without verifying.
  - **The model**, when the work is routine and its quality depends on following clear instructions rather than on reasoning or knowledge (sorting, extracting, summarizing within a clear frame, a small change that follows an existing pattern). It does not fit work that needs broad knowledge, a long context, judgment on an ambiguous request, or reliable tool use across many steps. After changing the model, use that model's usual effort, since effort levels are not equivalent across models.
- **How.** Run the work on the lighter side, and have the start point review it. Do not also run the full work on the start point to compare.
- **Judge.** The trial passes when the review asks for no large fix: no change of approach, no rework of a large part, no missed requirement. Read a failure by its kind: skipped steps, unchecked claims or shallow reasoning point to the effort; missing knowledge, invented facts or APIs, ignored instructions or a misread request point to the model. Record the kind, so a later trial does not repeat a change that already failed.
- **Record.** In the task's report, write in one line what ran with which model and effort, whether the review needed a large fix, and if so whether it pointed to the effort or the model.

## 3. Rewrite the model rules

- **Propose, do not write.** After a passing trial, the owner proposes in the report the rule to add or change, with its new wording. The coordinator writes the project policy when the user agrees. A trial that needed a large fix leaves the rules as they are.
- **Describe the work by its nature.** Write a rule by the work's scope, the weight of its judgment and how much it reads, not by a task's title or topic, so it fits the next task of the same kind. Widen an existing rule before adding a new one.
- **Keep the first match right.** Place a rule above any broader rule it overlaps.
- **Stay within the limit.** Keep the rules within the limit the policy states (15 bullets and 1500 characters if it states none). When an addition would exceed it, merge rules of similar nature into one, then drop supporting notes such as why a rule was chosen.
