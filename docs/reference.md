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
