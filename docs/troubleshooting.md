# Troubleshooting

If the screen opens, the quickest way is to ask the AI in the input box ("Why isn't the booking form task moving?"). The AI can read the steps for fixing things.

Don't delete the data folder (`~/alpacawork`) or record files yourself to start over.

## A task stopped

A task under "Needs attention" has an AI run that stopped. Open it to see the reason under the title.

- "Failed": Press "Retry" or "Stop". If you want it done differently, write that in the input box and send it instead of pressing a button. If the reason is a usage limit or a busy model, press "Retry" after the limit resets, or ask in the input box: "Retry with a different model." It doesn't restart by itself when the limit resets.
- "Limit hit": The automatic back-and-forth between AIs reached its set number of times (20 at first). If it's fine to go on, press "Continue".
- Reasons with no button ("Receipt unconfirmed", "No launch profile" and so on): Read the message shown, and give an instruction in the input box, such as "Continue." What they mean is in [Why a task stopped](reference.md#why-a-task-stopped).

## You sent it, but nothing happens

The sending status appears above the input box. Press it to open the conversation with the coordinator.

- "Sending…", "Queued", "Working on it…" and so on: Wait.
- "Not sent (reason)": Read the reason, fix it, and send again.
- "Couldn't confirm whether it arrived.": Open the conversation and press "Send again" or "Cancel".
- "Could not receive a reply": Press "Send again". Attachments aren't sent again, so for a request that had attachments, write it again and send. If it was a usage limit, wait for the limit to reset, or choose a different model, then send.
- "Could not start the coordinator.": See "AI agents can't be used" below.

## Not sure whether a task is moving

- If the time on an "In progress" row keeps going up, the AI is working.
- "Last output is old": It hasn't necessarily stopped. Wait a while, and if nothing changes, ask in the input box.
- "Queued" on a row: The limit on how many run at once has been reached, and it is waiting for a free slot.
- "Waits for T12" on a row: It is waiting for T12 to finish. If T12 has stopped, deal with T12 first.

## The PC restarted or went to sleep

When you log in to the PC, alpacawork starts by itself, and your tasks are as you left them. Work that was going on before the restart stops. For a task that moved to "Needs attention", open it and press "Retry". It doesn't restart by itself.

No work gets done while the PC is asleep. A laptop stops when you close the lid.

## The screen doesn't open

If you see "This site can't be reached", alpacawork isn't running. Start it, then reload the page.

- Run `alpacawork start` in a terminal.
- Windows: Opening Ubuntu from the Start menu starts alpacawork too. Leave that window open. If the screen still doesn't open, run `alpacawork start` in that window.

If you forgot the URL, see [Open the screen again](manage.md#open-the-screen-again).

`http://127.0.0.1:...` can't be opened from other devices. Use the `https://` URL from [Use it from your phone](remote.md#use-it-from-your-phone) or from [On a PC you connect to over SSH](manage.md#on-a-pc-you-connect-to-over-ssh).

If it stopped starting after you updated Node.js, run `alpacawork setup` and press Enter.

## "Offline" or a similar message appears

- "You're offline" or "Waiting for alpacawork to respond.": Check that alpacawork is running ("The screen doesn't open" above). It comes back by itself once connected.
- "alpacawork's version has changed.": Press "Reload".
- "This machine is under heavy load": Press "View" to see what is heavy, and lower how many run at once.

## AI agents can't be used

Their state appears under "Agents" in "Settings (the gear) → Server".

- "Sign-in required": Run the sign-in command in a terminal.

  | AI agent | Command |
  | --- | --- |
  | Claude Code | `claude auth login` |
  | Codex | `codex login` |
  | GitHub Copilot | `gh auth login` |

- "Not found": Install it if you haven't. If it is installed, set where it is in "Executable" on its card.
- "No agents are enabled": Turn on the AIs to use.

After fixing it, use "Retry" to move the tasks that had stopped.

## The install stops

Fix the cause shown, and run the same command again; it carries on from where it stopped.

- `requires Node >=24.16.0`: Install Node.js 24, then run it.
- `command not found`: Open the terminal again.
- An error saying it can't write, or `does not run as root`: Run it without `sudo`, with a Node.js installed through nvm or similar.
- `User service manager is unavailable`: On WSL2, [turn on systemd](manage.md#on-windows).

For any other message, paste the text as it is to an AI and ask for help.

## What to give an AI when you ask for help

Start Claude Code or Codex in a terminal, call the alpacawork skill (`/alpacawork` or `$alpacawork`), then give it:

- The message exactly as it appeared, and the task number (such as T12)
- What you did just before it happened
- The output of `alpacawork workspace url`

Report bugs in [Issues](https://github.com/alpacakit/alpacawork/issues). Don't write security vulnerabilities in an Issue; report them following [SECURITY.md](https://github.com/alpacakit/alpacawork/blob/main/SECURITY.md).
