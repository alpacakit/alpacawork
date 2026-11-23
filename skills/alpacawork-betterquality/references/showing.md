# Showing a result to an audience stand-in

Read this when the frame has checks of whether the result lands with its audience.

## The brief

Each round, start a **new** stand-in: a new subagent or agent conversation that does not inherit yours (no fork of the builder's context). Write the brief in the language the real audience reads, and give it only:

- the role, written from the background in the frame, including their own circumstances that the purpose needs. When the audience already uses the result, include what they are used to (how they do the task today). For example: "You are a developer who uses Claude Code daily and knows Cursor; you have never heard of this tool; you scroll past this on X with the sound off." or "You run a small bakery and use your phone for everything; this error appears while you are paying a supplier.";
- the result, shown as the audience meets it (see "Showing it, by kind");
- for something to be used, the task: what they want to get done at that moment, in their words;
- the least needed to operate or view it: which tool to use and how, where to stop, and what not to do (for example, not to send or pay). This is not the intent and need not be withheld;
- the questions.

When people come with one need at a time, give each stand-in one need; with many needs, pick a few that differ. A stand-in given a long list answers from memory after reading everything once.

Withhold the purpose, the frame, the checks, earlier versions, the builder's intent and other stand-ins' answers. A stand-in that can read files can find them: keep the frame and the log in a work location outside the result and out of its reach, and tell it to open nothing but what it is shown.

## Showing it, by kind

Only how the stand-in meets the result changes with its kind. A result can fit more than one row; combine them. Look for a skill or tool in this environment that gives the stand-in the experience (operating a browser, playing a video, capturing a screen) and tell it how to use it. If none can, build the experience another way; if that is not possible either, do not substitute your own description of the result — tell the requester. Note in the log whatever differs from the real moment.

| Kind | How the stand-in meets it |
|---|---|
| Text (documents, messages, error text) | The text as delivered, in the place and format it is read, nothing added around it. |
| Image | At the size and on the background it is seen at; the role says how briefly the audience looks, and they are asked first what they noticed. |
| Video | Played in order, once through, with no short event or caption dropped, with sound on or off as the audience would have it. |
| Something people use (a web page, an app screen, a command) | A real task phrased as the user's goal, not in the result's own labels ("you want to see which requests are waiting for you", not "open the Waiting tab"). They operate it themselves, from the state the audience would be in, on the device and at the size they use. Use a copy with test data when operating it could change real data or act outside. Have them list the steps they took. |
| A choice among options (a name, an offer) | Shown among what the audience would otherwise pick, with "none of these" allowed, without saying which one is under test. |
| Anything else | Recreate the moment the audience meets it as closely as you can, and give the stand-in that and nothing more. |

## Questions

Word them for the audience's situation, and keep them the same across rounds unless the checks change.

1. For each check, an open question whose answer shows whether it passed — for example "What would you do next, and why?" when the purpose is an action, or "Would this suit your case? Why?" when it is a judgement. Do not put the result's own terms or the expected answer into a question: "how does this differ from a chat?" already tells them it differs, and "what would you use this for?" assumes they would use it.
2. "Where did you stop, hesitate, misread, or give up? For each: where exactly, what you thought at that moment, and why."
3. For something people read: "What did you read on the way that you did not need for this?" (a hint for the builder, not the judgement)

Tell the stand-in to answer from the result alone and to say "I don't know" rather than guess. Scores such as "interest 1 to 5" vary between stand-ins; ask for one only as a note, never as a check. The stand-in cannot tell whether what it inferred is true; checking that against the facts is the builder's job.

## Comparing several candidates

When the result is a choice among candidates (names, openings, layouts), or when comparing the direction with an alternative, one round shows every candidate under the same questions — each to its own new stand-in with the same role and model, or, when the audience sees them side by side, together in one list — and judges every candidate by the same rule, written before the round. Keep candidates few (about 3 to 6); after the first round, fix and re-show only those you would put forward. Recommend among those that met the gate; if you have to choose by something added after seeing the answers, say so. Give the candidates you put forward the same checks, including the final check, or say which checks a candidate did not get.

## The log

Keep one log in the work location, outside the result and out of the stand-ins' reach: the frame, each version (or where it is), each brief and answer as returned (point to each screenshot or recording you keep by its file name, and delete the ones not pointed to once the report is written), and per round the role and model, pass or fail per check and for blocking stumbles, and what was changed. End it with this block, one item per line, so that outcomes can later be compared:

```text
result kind:
audience and background:
purpose:
purpose confirmed by requester: yes | no (reading)
direction: kept | restarted from an alternative or a mix | kept (fixed by requester) | not questioned (why)
checks and gate:
round cap / rounds used:
stand-ins (in loop, final):
final check: pass | fail | not run
outcome: gate met | cap | stuck
what made the difference:
```

## When you cannot change the result

When someone else owns the result, run one round on the current version with an alternative, and report the stumbles, whether the direction holds, and the fixes you would make.
