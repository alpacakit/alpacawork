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
| `alpacawork analysis list --period today --set finished` | The Tasks behind a number, including today's finished marks |
| `alpacawork analysis task --task <task>` | One top-level Task's values, including the requested child when it resolves to that parent |
| `alpacawork analysis owner-choices --project <project> --purpose "<purpose>" --weight "<weight>"` | Recorded outcomes and costs for owner model and effort choices |

When sending the first instruction to the owner of a user-requested Task, `task request` accepts `--purpose`
and `--weight` together. Use the project's policy labels. The read command uses the same labels and groups witnessed
owner launches through the first acceptance, send-back, review-time instruction or stop. Mixed choices are counted
in the totals. Each row shows up to five pass or rework judgments, pending task IDs and median cost for completed
judged cases. Costs sum Run time and measured output tokens across the Task and its descendants, including Runs
after acceptance. Pending task IDs can include cases whose owner choice is still unknown.
An early rework remains reworked here if the Task is later stopped without acceptance. Task analysis counts it as stopped.

To use the optional selection guidance, copy `skills/choose-model-with-evidence` from the repository into your agent's
skills directory.

Periods are `today`, `7d`, `28d` and `all`. Use `--end YYYY-MM-DD` to move the first three periods.
Use inclusive `--from YYYY-MM-DD` and `--to YYYY-MM-DD` for a custom range. The server's time zone can be
overridden with `--time-zone <IANA-zone>`. Trend buckets are `day`, `week` and `month`.
A comparison uses the immediately preceding period of equal length when there is enough history.

Task counts use Tasks the user directly requested. The rework count uses instructions addressed to the top-level Task. The share is `null` when fewer than 10 Tasks were accepted. Time values are in milliseconds.

AI usage includes work on all Tasks and groups child launches under their top-level Task. A launch requires a recorded
process start. Elapsed time includes live Runs up to the time of the read. A Run that joined another counts as input to
that process. The response counts launches without stored token counts separately. Skill, tool and MCP breakdowns
report how many launches have been tallied. Skill file reads issued as part of compound shell commands are excluded.
Task completion dates and launch dates use the time zone echoed in the result.

For a drill-down, choose `--set passed|reworked|stopped|accepted|finished|used` and a period or inclusive `--from` and
`--to` dates. Pass the breakdown row's `--by` and `--key` to limit the list to that row. Tool and MCP keys are JSON
arrays with two strings: use `--key '["provider","tool"]'` for a tool, or `--key '["provider","server:tool"]'` for MCP.

| Set | `--by` | `--value` |
| --- | --- | --- |
| `passed`, `reworked`, `stopped`, `accepted`, `finished` | `model`, `agent`, `project` | `lead`, `submits`, `questions`, `prs`, `you`, `ai`, `other` |
| `used` | `model`, `agent`, `project`, `skill`, `tool`, `mcp` | `launches`, `runMs`, `newConversations`, `output`, `input`, `cache`, `calls` |

`calls` requires a `tool` or `mcp` breakdown. `--value` returns and sorts by that contribution. `--limit` accepts up to
100 rows. Use the returned `cursor` with the same selection to get the next page. Related PR counts use distinct GitHub
links from task values and reports. The list credits a shared link to the first contributing Task ID in the selection.
