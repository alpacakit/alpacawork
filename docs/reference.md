# Words and commands

Look up the meaning of words you see on the screen. You can ask the AI in the input box what a setting means.

## Roles

| Word | Meaning |
| --- | --- |
| You | The person using the screen |
| Coordinator | The AI you talk to. Everything you send from the input box goes here |
| Owner | The AI that takes on one task |
| Member | An AI the owner calls in to help |
| Parent, Subtask | The task one level up, and a task split off below |

## Task states

| Word | Meaning |
| --- | --- |
| In progress | The AI is working |
| Awaiting review | Your turn. A question or a report has arrived. Also shown as a task's state while a report is waiting for you to check |
| Needs attention | Your turn. An AI's run has stopped |
| Waiting | Waiting for some other reply. Not your turn |
| Not started | Hasn't started yet |
| On hold | Something you put off |
| Done | Finished. Stopped tasks are here too |
| Error | Stopped. In the list, it is under "Needs attention" |

## Why a task stopped

These appear on rows under "Needs attention". What to do is in [Troubleshooting](troubleshooting.md#a-task-stopped).

| Word | Meaning |
| --- | --- |
| Failed | The run failed, or ended without a report |
| Limit hit | The automatic back-and-forth between AIs reached its limit |
| Receipt unconfirmed | It can't be confirmed that the AI received it. See how far it got in "History" |
| Refused | A follow-up request was not accepted |
| No launch profile | That AI agent isn't in the settings, or isn't enabled |
| Can't start | The AI that takes on the task can't be started |
| Can't resume | The earlier conversation can't be continued. Tell it to "Continue in a new conversation" |
| Depth limit, Request limit | The number of levels of subtasks, or of requests in one run, reached its limit |
| Timed out | One run went over its time limit |
| Ended early, Did not start | The AI agent's program stopped, or couldn't start |

## Keyboard

"⌘/Ctrl" means ⌘ on a Mac and Ctrl elsewhere.

| Key | What it does |
| --- | --- |
| `/` | Go to the input box |
| ⌘/Ctrl+Enter | Send on any device (on a PC, Enter alone also sends) |
| `#` in the input box | Choose a task or project to attach |
| ⌘/Ctrl+K | Search |
| ⌘/Ctrl+, | Open Settings |
| Esc | Leave the input box, close the open task |
| H | Put the open task on hold |

## Commands

Run these in a terminal (on Windows, inside Ubuntu). The other commands are for the AI.

| Command | What it does |
| --- | --- |
| `alpacawork setup` | Install |
| `alpacawork setup --yes --port <number>` | Change the port of the screen's URL |
| `alpacawork setup --yes --public-host <name>` | Set the `https://` name used to open it from other devices |
| `alpacawork open` | Open the screen in the browser |
| `alpacawork start`, `stop`, `restart` | Start, stop, restart |
| `alpacawork status` | Show whether it's running, and the screen's URL |
| `alpacawork workspace url` | Show the screen's URL |
| `alpacawork deploy npm:alpacawork` | Update to the latest version |
| `alpacawork uninstall` | Remove it from this PC. The data folder stays |
| `alpacawork --version` | Show the installed version |
| `alpacawork telemetry off` | Stop sending usage data |

### Analysis

The screen and these read commands use the same counts. A person or the coordinator can read all projects, or use
`--project` to include a project and its nested projects. A Task Run reads only its own project. Nested projects are excluded from that Run's scope.

| Command | What it reads |
| --- | --- |
| `alpacawork analysis tasks --period 7d --bucket day` | Finished Tasks, time to acceptance, trends and daily finished counts, and the waits of unfinished Tasks as of now |
| `alpacawork analysis usage --period 28d --bucket week --by model` | Task Run launches, elapsed running time, new conversations and measured tokens |
| `alpacawork analysis breakdown --period 7d --bucket day --look usage --by model` | One breakdown alone, the rows `analysis tasks` or `analysis usage` gives with `--by`, without their totals and trends |
| `alpacawork analysis list --period today --set finished` | The Tasks behind a number, including today's finished marks |
| `alpacawork analysis task --task <task>` | One top-level Task's values, including the requested child when it resolves to that parent |
| `alpacawork analysis trace --task <task>` | One Task's timeline: lanes, spans, marks, a breakdown of its wall time and which Runs have step times |
| `alpacawork analysis findings --task <task>` | Places in that timeline worth a look, each by a rule with its threshold and evidence |
| `alpacawork analysis at --task <task> --at <ISO>` | The situation at one instant: states, Runs and their steps, the queue, open questions, recent history, and the Task's values then (as `task values --at` reads them; null with `valuesReason` when not known) |
| `alpacawork analysis changes --period 28d` | When what Runs ran under changed (version, skills, instruction files, a seat's model or effort) |

Periods are `today`, `7d`, `28d` and `all`. Use `--end YYYY-MM-DD` to move the first three periods.
Use inclusive `--from YYYY-MM-DD` and `--to YYYY-MM-DD` for a custom range. The server's time zone can be
overridden with `--time-zone <IANA-zone>`. Trend buckets are `day`, `week` and `month`.
A comparison uses the immediately preceding period of equal length when there is enough history.
Both commands return `ever` for the same scope from the first day of the record through today. It matches the totals
for `--period all` and is `null` when the scope has no records.

Task counts use Tasks the user directly requested. A review round (`submits`) is a submit for review, or a question to
the user from the Task or any Task under it that asks whether to take a result as it is (one of its items has
`decide_kind` `accept`). `submits` counts the times a result was put to the user, not the round it passed on: a Task
whose question was answered "take it" and that was then submitted for review has two. A question asked before its kind
was recorded is read from its words (merge, adopt, accept and the like); `submitsEstimated` counts the accepted Tasks
whose rounds rest on that reading. A Task is reworked when the user sent it back, gave an instruction at review or after
acceptance, gave an instruction in place of answering a question asking to take a result, or it was submitted for review
twice or more. An instruction that names a withdrawn question it answers counts as one given in place of its answer; one given
after the acceptance counts in `instructionsAfterAccept` instead.
Only questions asked between the request and the end count. Answering such a question, with a choice (even one that asks for changes) or with the user's own words, is not
rework. The instruction
counts (`sendBacks`, `instructionsAtReview`, `instructionsAfterAccept`, and `instructionsDuringWork`, which is not
rework) read the top-level Task's own history, plus the instructions
that replaced questions anywhere under it. The time a question asking to take a result stayed open is review time
(`time.review`), not `time.answer`. `doneUnaccepted` counts top-level Tasks their owner reported done without the user accepting them,
whether the user requested them or not (a Task the user requested goes to review instead, so these are mostly Tasks
the coordinator or an agent made without the user requesting them); they are not among `finished`, their times stop when they were done, and their list rows give
`doneAt` with a null `outcome` and `finishedAt`. The share
is `null` when fewer than 10 Tasks were accepted. Time values are in milliseconds.

`waits` splits the time the user was waited on (`time.review` plus `time.answer`, the `--value you` of a list) by where
the user was. The user's actions on every Task (their own, and the coordinator's for them) and their messages to the
coordinator are laid in one line. A gap of 30 minutes or more without an action is treated as `away`. A shorter gap
counts toward the Task of the next action: `thisTask` when that Task is this one or under it, `otherTasks` otherwise (a
message that names no Task included). After the last action, the time until now is `thisTask` while under 30 minutes;
once 30 minutes pass, all of it is `away`. Reading a screen leaves no action, so a long read counts as away. In `analysis tasks` the period totals cover
accepted Tasks; `unfinished` gives, as of the read and whatever the period, the requested Tasks open now: with no acceptance,
stop or owner's done yet (`doneUnaccepted` ones are not among them), or reopened after one, counted from that end; with
their waits so far (a wait
still open running to now), and `analysis task` gives one Task's.

`questions` counts every question to the user, including those asking to take a result that `submits` also counts.
`answerItems` counts the answered items of those questions by the kind of the answer's recorded part: one of the choices
(`choice`, and `recommended` of those), none of them with the user's own words (`other`), `stop`, or no choice named
(`unmatched`); `recommendable` counts the items whose asker recommended a choice. Answered questions with no recorded
parts are `answersWithoutParts`. `questionsReplaced` counts questions withdrawn by an instruction in place of an answer.
`instructions` counts the user's instructions and send-backs to the Task or any Task under it after the request
(answers are not counted) by the label their sender gave each (`kinds`, and `fixes` for the kinds of fix; an instruction can
name several fixes, and kinds with no count are left out); `unlabeled` were sent without one. `noQuestions` counts the
accepted Tasks with no question to the user besides those asking to take a result, and `passedNoQuestions` those of them
accepted without rework. `analysis task` returns the same values for one Task, with `submitsEstimated` as true or false.
`rounds` splits a Task's time from its request into review rounds: each is the work up to one review (as `submits` counts
them) and the wait until the user answered, withdrew or sent it back, the next starting where it closed and the last
running to the end (or now). Each round's `tokens` are those of the Runs of the Task and under it that started in it. In
`analysis tasks` the accepted Tasks' rounds are summed as `first` (each Task's first round) and `later` (the rounds after
it: the work redone and waited on), each with its `ms` and `tokens`.
Each Task trend point includes `accepted` totals for the Tasks accepted in that bucket. A related PR counts once,
on the earliest acceptance day of any Task that references it in the project scope. Trend points and period totals
use that same day. The Task model and agent breakdowns use the earliest owner Run on the top-level Task.
If there is no owner Run, the breakdown row has `noOwnerRun: true` and a separate key for its drill-down list.

`analysis trace`, `analysis findings` and `analysis at` read one Task from its creation to now, or to its last record
once it and the Tasks under it are done or stopped. `--from` and `--to` are instants (ISO, such as
`2026-11-24T09:00:00Z`); a period that does not end after it starts is refused, and a record at either end is kept. The
breakdown, `time`, `waits` and the findings always read the Task and every Task under it; `--scope subtree` lists the
lanes, spans and marks of the Tasks under it too, and `--lanes` lists only the lanes named. The trace's `breakdown` gives
each instant of the wall time to the first part that holds: `owner-working`, `member-working`, `child-working`, `held`,
`waiting-answer`, `waiting-review`, `queued`, `idle`; the parts sum to `wall`. A child's work and its questions show as
`child-working` and as `question` spans on its lane, so the trace has no separate span for waiting on a child, and a
question's span starts where it was asked. As in the counts, a question asking to take a result is `waiting-review`.
`time` (`review`, `answer`) and `waits` follow the same rule as `analysis task`: an open question to the user counts even
while an AI works, so they can exceed `waiting-answer` + `waiting-review`; for a top-level Task they are the same numbers.
A Run has step times only from when they were kept. `coverage.steps.unknown` names the Runs without them by reason:
`before-step-times` (the Run started before they were kept), `provider-unsupported` (its agent's output names no steps
alpacawork reads) and `missing-step-times` (its output has steps whose times were not kept). While any Run in the period
lacks them, the step-level values (`toolMs`, `thinkingMs`, `stepWorkMs`) are `null`, not 0, and that Run has no
`thinking` spans (the time inside a Run with no step running). Spans and marks come in time order, `--limit` at a time;
`cursor` reads the next page of the same `head.version` of the records and is refused once they change. `head.settled`
says the numbers no longer change with the time of the read.

Findings come from an experimental rule set (rule IDs stay; thresholds may change). `--threshold rule=value` takes
minutes for a time and a count for a repeat. A finding's evidence names the Run, step, question or record it stands on;
a record carries its first line. The rules:

- `long-wait`: a question (to anyone) open while no AI of the task or under it ran; at: when it was asked, durationMs: that time.
- `repeated-question`: one task asking about the same pull request (with its repository when a link names one), or with the same choices, again and again; at: the first, durationMs: the time they were open, count: how many.
- `long-step`: a step this long, or 3 times the median of its fingerprint and at least 30 seconds (a sub-agent judged by its own steps); at: its start, durationMs: its length.
- `limit-hit`: a command the Run's manager stopped at the command time limit; at: when it started, durationMs: the limit.
- `repeated-failure`: one command failing with the same whole output again and again in a row (writes between allowed); at: the first, durationMs: their time together, count: how many.
- `same-result`: one read or command known to have succeeded, again with the same whole output and no write between (an edit, or a command that writes or may write); a repeated task get or git status included; at: the first, durationMs: their time, count: how many.
- `fan-out`: one fingerprint with differing arguments many times in one Run (one by one where one read could do); at: the first, durationMs: their time, count: how many.
- `queue-wait`: a Run that waited this long before it started; at: when it was made, durationMs: the wait.
- `failed-run`: a Run that failed or was stopped, with the Run that took its place; at: its start, durationMs: its length.
- `rework`: work done again by the counts' rule (a send-back, an instruction at review or after acceptance, one in place of answering a question asking to take a result); at: the record, durationMs: until that task next puts a result to the user (waits for review or asks to take it) or is done.
- `idle`: a stretch this long with nothing running, queued, asked or in review in the task or under it; at: its start, durationMs: its length.

An `instruction` mark's `label` is what its sender said it was (`kind`, and `fixes` for a fix), or `null` when it was sent with none.
`url` in the answers of `analysis trace`, `analysis findings` (and each finding) and `analysis at` is the screen's address
of the same scene, a path relative to the screen: the Task's Analysis tab at an instant (`at`) or on a finding (`finding`). `analysis changes` takes the scope and days of `analysis tasks`. A
placement's agent, model and effort come from the launch records and compare the Runs of that placement. Version,
skill and instruction-file changes need the Runs' condition records and compare each agent's Runs in the order they
started; `runs.recorded` counts the period's Runs that have them. An item added to or gone from a set already recorded
is a change; the first conditions recorded are not.

Model breakdowns and `analysis task` group by model name and launch effort. They use the model recorded in the
Run's tally when available, then the launch model, then the agent name. A Run can move to a different row when
its tally becomes available after it ends. After a server restart, even a completed Run may appear under its launch
model or agent name until its tally is loaded and its reported model becomes available.
Model rows with a Run return `model.name`, `model.effort` (`null` if unspecified or only the agent name is available)
and a readable `label` such as `example-model-v2(high)`. Pass the breakdown row's `key` to `analysis list`.

AI usage groups launches from Tasks and their descendants under the top-level Task, including launches from deleted
children. A deleted top-level Task and its subtree are excluded. A launch requires a recorded process start. Elapsed
time includes live Runs up to the time of the read. A Run that joined another counts as input to that process. Live
Runs are tracked separately from launches whose token count is unavailable. Skill, tool and MCP breakdowns expose the
collection start date in `since` after the first tally is available in scope. Tallies cover ended Runs whose launch
and end were both at or after the exact collection start time. `counted` gives calls and distinct launches for the
selected period.
For skills, the launch count covers launches that used at least one skill and `calls` is zero. `breakdown.series`
aligns with the usage trend points. Buckets wholly before `since` and comparisons that start before `since` are `null`.
Shell reads of skill files are counted once per skill per tool call, including
reads in sequences and pipelines. Redirection targets and in-place edits are excluded. Task completion dates
and launch dates use the time zone echoed in the result.

For a drill-down, choose `--set passed|reworked|stopped|doneUnaccepted|accepted|finished|unfinished|used`
(`unfinished` lists the Tasks `unfinished` counts, whatever the period) and a period or inclusive `--from` and
`--to` dates. Pass the breakdown row's `--by` and `--key` to limit the list to that row. Tool and MCP keys are JSON
arrays with two strings: use `--key '["provider","tool"]'` for a tool, or `--key '["provider","server:tool"]'` for MCP.
With `--set used --by skill|tool|mcp`, omit `--key` to list Tasks with at least one matching launch since collection began.
`--value launches` counts each matching launch once, even if it used several entries in that breakdown.
`--value calls` sums all calls for the tool or MCP breakdown. The row values add up to the corresponding usage total.

| Set | `--by` | `--value` |
| --- | --- | --- |
| `passed`, `reworked`, `stopped`, `doneUnaccepted`, `accepted`, `finished`, `unfinished` | `model`, `agent`, `project` | `lead`, `submits`, `questions`, `prs`, `you`, `ai`, `other` |
| `used` | `model`, `agent`, `project`, `skill`, `tool`, `mcp` | `launches`, `runMs`, `newConversations`, `tokens`, `output`, `input`, `cache`, `calls` |

`tokens` sums output, input and cache. `calls` requires a `tool` or `mcp` breakdown. `--value` returns and sorts by
that contribution. `--limit` accepts up to
100 rows. Use the returned `cursor` with the same selection to get the next page. Related PR counts use distinct GitHub
links from task values and reports. `analysis list --value prs` shows the Tasks credited with PRs during the selected
period. Each link is credited to the earliest accepted Task in the project scope, with the lowest Task ID breaking a tie
at the same acceptance time. The accepted list's row values add up to the corresponding period total or trend bucket.
`analysis task` shows all PR links referenced by the Task.
