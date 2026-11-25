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
| `alpacawork analysis tasks --period 7d --bucket day` | Finished Tasks, time to acceptance, trends and daily finished counts |
| `alpacawork analysis usage --period 28d --bucket week --by model` | Task Run launches, elapsed running time, new conversations and measured tokens |
| `alpacawork analysis breakdown --period 7d --bucket day --look usage --by model` | One breakdown alone, the rows `analysis tasks` or `analysis usage` gives with `--by`, without their totals and trends |
| `alpacawork analysis list --period today --set finished` | The Tasks behind a number, including today's finished marks |
| `alpacawork analysis task --task <task>` | One top-level Task's values, including the requested child when it resolves to that parent |

Periods are `today`, `7d`, `28d` and `all`. Use `--end YYYY-MM-DD` to move the first three periods.
Use inclusive `--from YYYY-MM-DD` and `--to YYYY-MM-DD` for a custom range. The server's time zone can be
overridden with `--time-zone <IANA-zone>`. Trend buckets are `day`, `week` and `month`.
A comparison uses the immediately preceding period of equal length when there is enough history.
Both commands return `ever` for the same scope from the first day of the record through today. It matches the totals
for `--period all` and is `null` when the scope has no records.

Task counts use Tasks the user directly requested. The rework count uses instructions addressed to the top-level Task. The share is `null` when fewer than 10 Tasks were accepted. Time values are in milliseconds.
Each Task trend point includes `accepted` totals for the Tasks accepted in that bucket. A related PR counts once,
on the earliest acceptance day of any Task that references it in the project scope. Trend points and period totals
use that same day. The Task model and agent breakdowns use the earliest owner Run on the top-level Task.
If there is no owner Run, the breakdown row has `noOwnerRun: true` and a separate key for its drill-down list.

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

For a drill-down, choose `--set passed|reworked|stopped|accepted|finished|used` and a period or inclusive `--from` and
`--to` dates. Pass the breakdown row's `--by` and `--key` to limit the list to that row. Tool and MCP keys are JSON
arrays with two strings: use `--key '["provider","tool"]'` for a tool, or `--key '["provider","server:tool"]'` for MCP.
With `--set used --by skill|tool|mcp`, omit `--key` to list Tasks with at least one matching launch since collection began.
`--value launches` counts each matching launch once, even if it used several entries in that breakdown.
`--value calls` sums all calls for the tool or MCP breakdown. The row values add up to the corresponding usage total.

| Set | `--by` | `--value` |
| --- | --- | --- |
| `passed`, `reworked`, `stopped`, `accepted`, `finished` | `model`, `agent`, `project` | `lead`, `submits`, `questions`, `prs`, `you`, `ai`, `other` |
| `used` | `model`, `agent`, `project`, `skill`, `tool`, `mcp` | `launches`, `runMs`, `newConversations`, `tokens`, `output`, `input`, `cache`, `calls` |

`tokens` sums output, input and cache. `calls` requires a `tool` or `mcp` breakdown. `--value` returns and sorts by
that contribution. `--limit` accepts up to
100 rows. Use the returned `cursor` with the same selection to get the next page. Related PR counts use distinct GitHub
links from task values and reports. `analysis list --value prs` shows the Tasks credited with PRs during the selected
period. Each link is credited to the earliest accepted Task in the project scope, with the lowest Task ID breaking a tie
at the same acceptance time. The accepted list's row values add up to the corresponding period total or trend bucket.
`analysis task` shows all PR links referenced by the Task.
