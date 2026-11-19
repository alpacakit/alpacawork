---
name: alpacawork-betterquality
description: An alpacawork add-on. Owners and coordinators working in alpacawork use it when planning work, when asking for a review or receiving findings, and when fixes to a result stop converging; an agent asked for a review uses it to review. Install it alongside the alpacawork skill if you want to raise the quality of results through planning. It is not a skill about writing tests.
---

# alpacawork-betterquality (decide quality in the plan, review the real thing)

These rules are added on top of the alpacawork skill, because the quality of a result depends heavily on the plan made before building. If you start thinking about what is good and bad only after you begin building, the heaviest decisions get made without being compared, and review does no more than fix the details of a shape that is already decided.

This skill does not change the alpacawork skill's guardrails or its delivery mechanism, and the scope of approval follows "Approval defaults" there. Requests, the choice of conversation, verification, records and reports follow the alpacawork skill, and this skill adds to them: what to decide before building, how a review is asked for and done, what to keep of it, and when to hand the work to a new agent.

## Who uses which part

- Plan, asking for a review, handling findings: the agent responsible for the result. How much of this the coordinator takes on is governed by [alpacawork's "Principles of the role"](../alpacawork/references/coordinator.md#principles-of-the-role).
- Reviewing: the agent asked for a review follows ["What the reviewer does"](#what-the-reviewer-does).

The sections are in the order of what to think about; they do not fix the shape of the process. Spend in proportion to the weight of the decisions. Work that has only light decisions needs no written plan and no reviewer: check the real thing yourself, and say in the report that it was self-checked and why. Do not skip independent review when the user's instructions, the project policy (the policy chain) or the request text require it.

## Weight of a decision

- Judge weight per decision, not per task. Within one task, the skeleton can be heavy while the wording is light.
- Measure weight as "cost of undoing × breadth of impact".
- Rule of thumb (not fixed). If the user's instructions, the project policy or the request text state numbers, follow them.

| Weight | How to tell | Number of options | Review |
|---|---|---|---|
| Light | A detail that is quickly undone | 1 | After building, by yourself or by one reviewer |
| Medium | Takes effort to undo | 1 to 2 | After building, by one reviewer other than the builder |
| Heavy | Costly to undo and broad in impact (the skeleton, for example) | 2 to 3 genuinely different ones | The plan before building, and the result after building, by two or more reviewers with different models or different viewpoints |

- Difference matters more than number. Options count only when they are genuinely different shapes; a rewording of the same shape is one option. Reviewers count only when they differ in model or in viewpoint; calling the same model again with the same viewpoint is not another pair of eyes.
- Do not hard-code a model name for the reviewers. Choose the model and effort from what can be selected at the time (`params` of agents in `alpacawork config get`) so that the reviewers differ.
- The agent responsible for the result chooses from the rule of thumb, and writes in the plan, one line per decision, the weight it gave, the number of options and reviewers, and why.

## Before building (plan)

The plan is the four items below, each as long as the weight of its decisions needs and no longer. Write only the points this work could get wrong.

1. **Yardsticks.** Decide what is good and what is bad for this result.
   - Separate the original purpose from the means. Start from the smallest result that does what the user's words ask; anything beyond those words needs a reason that comes from the purpose.
   - Write the context of use: who or what uses the result, when, and to decide or do what; in what unit the thing being decided or acted on is taken; and where the information used at that moment comes from. Facts that the builder or the mechanism needs in order to work correctly are not the information a person uses at that moment to decide and operate; do not treat the two the same.
   - Hold the user's original words, and the evaluations and lessons in memory, against that context of use.
   - If this work could fail for the same reason as a past failed example, write that example into the yardsticks without rewording it. Reading memory yourself does not get it to the builder or the reviewers.
   - Even when the request only adds something, put the whole in order, including fixing or deleting the existing parts it affects. Do not widen the work into unrelated improvements.
2. **Ways to spot a bad state.** For each yardstick, separate the required pass conditions from optional improvements, following [the done conditions of an alpacawork request text](../alpacawork/references/request.md), and write who finds a bad state, with what, and under which conditions. Verify under the actual conditions of use.
3. **Investigation and options.** Limit investigation to the affected area, in proportion to the weight and uncertainty of the change, and stop once you know the grounds and the impact needed for the decision. Keep it short for a known, local change. Check the existing mechanism against primary sources and against how it is actually used, and make use of the parts that serve the purpose. For a heavy decision, including the unit and the information source set in item 1, lay out genuinely different options before building, because choosing the skeleton again after building means a large amount of rework.
4. **Choosing, and reviewing the plan (heavy decisions only).** Before building, have other pairs of eyes choose among the options and review the plan itself, in one request: a mistake about the context of use, the yardsticks or the ways to spot a bad state is hard to find after building. When the choice belongs to the user (the user asked for options, or the project policy reserves the choice), ask the user once, with rough samples of the options, before polishing any of them. Until the user has chosen, give a sample or a proposal at most one review round: one sentence from the user can discard a direction, however many rounds it has passed.

Write the plan once, in the place the builder and the reviewers read: in the request text when another agent builds, otherwise in one file in the task folder. The reviewers read it there.

How to verify a result, and completion, follow ["Checking a result against the request"](../alpacawork/SKILL.md#checking-a-result-against-the-request) and ["Delivery and completion"](../alpacawork/references/lifecycle.md) in the alpacawork skill.

## While building (review)

### Asking for a review

5. **The builder checks the real thing first**, in the way that fits its medium: operate a screen at its actual width, read a document in the form the recipient gets, run a CLI or API with the user's input and check the output, and so on, together with the automated checks that cover what changed. Ask for a review when the result is whole and the builder's own check has passed; reviewing something the builder already knows is unfinished wastes a round.
6. **Then it is reviewed in a conversation and agent process separate from the building.** Switching roles inside the same conversation does not make an independent review. Give the reviewer, in one request:
   - the user's original words and what was agreed afterwards, the context of use, the yardsticks and the ways to spot a bad state (as a read command when the plan is already written somewhere);
   - the real thing in the version under review, with the startup and cleanup the review needs;
   - what the builder already verified and how, so that results that are still valid for that version, such as a test run, are not produced again;
   - a pointer to "What the reviewer does" in this skill, instead of a copy of it.

   When a stage has two or more reviewers, send their requests in the same wait cycle.

### What the reviewer does

- Read the user's original words before the builder's plan, and check first whether the result is what those words ask for: neither something different nor something more. Do not rely only on the builder's interpretation or yardsticks; look for cases where the proposal works and the original requirement is still not met.
- Take the user's position and examine the result from the opposite side: "What would I say if I were handed this?", "What stands in the way of being satisfied?", "If it is hard to use, hard to understand, or looks bad, where?"
- Check the real thing, in the way that fits its medium (item 5). The builder's explanation, a checklist or passing tests alone do not stand in for it. If the real thing cannot be checked, return it as unverified; do not pass it.
- Look at the skeleton first, including consistency across the affected area and misuse or duplication of existing mechanisms, and at the details next.
- Put the verdict first, as one of:
  - **Pass**: the required conditions are met.
  - **Fix**: the shape is right, and the findings can be fixed in place.
  - **Rebuild**: the direction differs substantially from what was asked, or building from scratch would be better than fixing. Give the reason and what can be reused, and do not go on to list the details of a shape that will be discarded.
- Return every finding of this pass in one reply, separated into required (a required pass condition fails) and optional. Attach to each finding the place in the real thing, the observed fact or the conditions that reproduce it, and the effect on use, and separate observation from guesswork. Do not make the number of findings a goal; if there is no problem, say so. Do not assert the user's satisfaction from guesswork alone.
- In a re-review, and in a review at a later stage of the same result, verify the changes to the real thing and their effect on how the parts fit together: whether the findings are resolved and whether the changes made anything worse. Do not decide what to cover from the builder's own account of the changes alone. Do not repeat already reviewed parts that the changes do not affect, and raise something new about them only when a required condition fails.

### Handling the findings

7. **The owner sorts each finding** into fix, reject with grounds, or unresolved.
   - If the grounds of a finding are unclear, check them, and do not make the result worse because of mere preference or an unreasonable objection.
   - Do not, without grounds, reject a finding that concerns a required condition or demote it to optional. An optional improvement may be put off with the reason recorded.
   - Before adding supporting work in response to a failure or a finding, compare that with a way of reaching the purpose without supporting work, starting from the original purpose, the results already verified and the problems that really remain. Do not add boilerplate documents or approval procedures for the sake of the comparison.
   - Do not settle a finding about the skeleton, or a recurrence of the same problem, by patching (adding parts or rules to keep the present shape). Go back to understanding the existing mechanism and choose the skeleton again (item 3); when ["Handing the work to a new agent"](#handing-the-work-to-a-new-agent) applies, follow it.
8. **Fix, then re-review, in rounds.** Make all the adopted fixes of a round before asking for the re-review, and ask the reviewer that raised the findings, in the same conversation: it already knows the result and what it found. Bring in a new reviewer only when the skeleton was rebuilt or a viewpoint was missing.
   - Counting: a review of the real thing, together with adopting or rejecting its findings and making the needed improvements, is one round. The first review is round 1, and the re-review of a revised version is the next round. The builder's check beforehand is not counted.
   - What is counted: the result the request asks for. What is made on the way to it (a plan, a draft of a question or a report, test helpers) is checked as part of that result and shares its count; it gets no rounds of its own.
   - Limit: the default maximum is 3 rounds including the first, unless an instruction you follow sets another limit. Record the limit before starting. Do not reset the count for a fix to the same result, a return to the skeleton, or a change of agent, conversation or task.
   - Ending: a Pass ends the review; do not ask for another pass to make sure. If the required conditions are met, every adopted fix has been made and nothing remains unverified, end even at the first round. The builder checks a fix made only for an optional finding; it does not open another round.
   - Checks: in each round, run the checks that the change of that round affects. Run a wide and slow check once, on the version to be delivered.
   - At the limit: report the unresolved and unverified items, their effect on use, and the next action. Do not treat places fixed after the final round as re-checked; if a required item is unresolved or unverified, return the result as failed or unverified. The limit is neither a reason to pass the result nor a reason to extend silently. Within the scope of approval, the owner decides what to adopt and what to reject, and raises only the decisions beyond its authority, through alpacawork's acceptance and reporting procedures.

### Handing the work to a new agent

Stop fixing in the current conversation, and have a new agent do the building from here, when any of these holds:

- The work is stuck (judge by failed fixes and the lack of new evidence, not by rounds or elapsed time alone): a fix for the same shortfall has failed twice, the fixes keep producing new problems of the same kind, the builder keeps going back to an assumption that was dropped, or the estimate has doubled while the required findings do not shrink.
- At review, the direction turns out to differ substantially from what was asked.
- The reviewer's verdict is Rebuild. Set it aside only when the reviewer got a fact or the request wrong; the work already spent and "it is nearly done" are not grounds.

A new agent is one that starts without the conversation that built the current result. Inside that conversation, the builder is pulled along by the assumptions of the approach being dropped, and each further fix costs a re-read of everything so far.

- When the builder is a member or a child's owner, place another agent, or send the next request with `--new-conversation`. Change the model too when the same one would likely arrive at the same shape.
- When the builder is you, hand the building to a child and keep the judging. Starting your own next conversation anew instead (`--next-conversation new`, on a report that carries the values) works only when your turn ends on a question or an open request; a `doing` report alone does not let you end the turn.
- Have the new agent start from the user's original words and the plan, and choose the skeleton again (item 3) before building. Pass the verified facts, the decisions and approvals that remain, and the approach to drop with the reviewer's reasons (as a read command). Name the parts worth reusing; do not pass the old result as the thing to continue from.
- The commands and conditions for switching follow [Tasks and requests: the common procedure](../alpacawork/references/request.md) and ["Reports" in Owner](../alpacawork/references/owner.md#reports). The round count carries over; if no round remains, report as "At the limit" in item 8 says, with the rebuild as the next action.

### Records

- A reviewer's reply stays in its Run, and what was adopted or rejected stays in the request for the fix or the re-review; do not copy either into a file. A reviewer called as the conversation's own subagent leaves no Run: put its verdict and required findings in the request for the fix or in the report. Record the limit and the rounds used in the task's values.
- In the report, write which version was reviewed and by whom (or that it was self-checked), the required findings rejected and why, what is unresolved or unverified, and why the review ended. Do not write a skipped review as carried out.
- When the user's own acceptance is required, do not replace it with independent review.
