---
name: choose-model-with-evidence
description: Use alpacawork outcomes to choose a model and effort for the owner of a user-requested task, within the project's model policy.
---

# Choose a model with evidence

Use the user's named choice first. Otherwise, read the project policy for the purpose, starting model and effort, and permitted changes. Follow the policy's requirements for how the work is done. Use this skill before assigning, replacing, or starting a new conversation for the owner of a user-requested task. A continuation uses its existing selection.

Estimate the weight from the difficulty and impact of the owner's judgment. Use the project's wording for purpose and weight. Read the evidence before choosing.

```sh
alpacawork analysis owner-choices --project <project> --purpose "<purpose>" --weight "<weight>"
```

Send both `--purpose` and `--weight` with `alpacawork task request` on the first instruction to the owner. Later requests and handovers use the context recorded with that instruction, when present.

## Find the current choice

The command shows the five latest pass or rework judgments for each choice, newest first. Open a rework judgment before relying on it. Check whether the original request was unmet. Skip cases that only added scope or introduced a new preference. Apply this filter when deciding whether to raise effort, return to a stronger choice, or try a lighter choice again. When the cause is unclear, use the policy choice without trying a lighter one.

1. Start at the policy's starting choice.
2. While the choice's two latest usable judgments are both rework, go one permitted step up.
3. While the next permitted lighter choice has two latest usable judgments that both passed and a lower median cost, move to it. Compare measured output tokens and Run time, including review and repair. Treat cost as lower when one median falls and the other stays at or below the current choice. Keep the current choice when either median is missing.
4. Use the choice where the walk stops. A step changes effort by one level or moves to an adjacent model from the same provider. Use choices that the configuration can start and stay within the project's bounds.

## Try a lighter choice

Try one task on the next permitted lighter choice when all of these are true.

- An independent reviewer will see the result before the user does.
- The current choice's two latest usable judgments both passed.
- The lighter choice has no confirmed rework in its judgment list. A confirmed rework rules out further trials for this purpose and weight until the model list or policy changes.
- There are no pending tasks on another choice and no pending tasks whose choice is undetermined. Use the current choice while any such task is pending.

A candidate with no judgments can get its first trial under these conditions. If the baseline evidence is absent or insufficient, keep the policy's starting choice. Recompute the choice when selecting again.

## Examples

- **Try and adopt.** High has two passes. Try medium once and use high while that task is pending. After medium passes, try it once more. With two medium passes and lower median cost, use medium. Stops and pending tasks leave its judgment list intact.
- **Try and return.** Medium is sent back, and high takes over the repair. The rework belongs to medium. After checking the original request, use high and stop trying medium.
- **Wait for evidence.** Medium has two pending tasks and one unjudged task. Keep high until there are usable judgments and the pending trials have settled.
- **Raise effort.** High has two confirmed reworks. Use the next available permitted choice up.
- **Skip added scope.** Medium shows rework followed by a pass, but the rework came from a request for a new feature after acceptance. Skip that judgment and consider another trial under the same rules.
