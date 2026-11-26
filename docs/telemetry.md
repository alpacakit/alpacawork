# Usage data

Usage data is a count of how alpacawork is used (which actions were used how many times, the version, the OS and so on). It is sent to the developer to improve alpacawork: to learn which features are used, where failures happen, and where the screen is slow.

Sending is optional. Nothing is sent until you choose, and alpacawork works the same if you don't send. After you choose to send, you can stop at any time and delete what was sent.

## What is sent

For each day you use alpacawork, that day's data is put into one report and sent the next day. Days are counted in UTC. No report is sent for days you don't use it. If a report can't be sent, it is retried for 7 days; after that, it is deleted without being sent.

A report contains:

- **Action counts**: Actions on the screen (pressing the send button, searching and so on) and changes made by commands from an AI or the terminal (creating a task, reporting its state and so on), counted by kind. Each count also carries the kind of device (phone, tablet or PC) and its OS, the route (a person on the screen, an AI, or the terminal, plus the kind of AI when it was an AI), and the screen's display language and theme
- **Environment**: The alpacawork version, the OS and CPU type, and the Node version
- **AI work**: The kinds of AI used (`claude`, `codex` and so on; names you gave them are not sent), counts per effort level, and how many times work failed partway
- **Size**: The number of projects and tasks, how deep the task tree goes, how many times an AI worked on one task, how many AI runs were going at the same time, and so on
- **Display speed**: How long it took from opening the screen or a task until its contents appeared
- **About the report itself**: The report's date, its format number, and this PC's ID

Each kind of action has a fixed name. Text you type and task titles are never included. Size, display speed and failure counts are sent as rough ranges such as `10-19`.

This PC's ID is a random UUID (version 4), made with a cryptographically secure random generator when you first choose to send. It is not made from names, accounts, or any information about the PC or the user. It is used to count how many days the same PC stays in use, and to let you delete sent data later. If you stop sending and start again, or delete what was sent, the same ID is used, as long as the file that keeps it remains. There is one ID per user account on the PC (kept by default in `~/.config/alpacawork/telemetry.json`).

You can see the actual report exactly as it will be sent ("See what is sent" below).

## What is not sent

- Task titles and text, conversations, the text of requests
- Names of files and folders, repository URLs
- PC and user names, email addresses
- The text of errors (only how many times errors occurred is counted)
- AI model names and token counts
- Contents of other tools' files, such as their settings or credentials (usage data doesn't read them)

IP addresses are not included in reports, and the receiver doesn't keep them. However, Cloudflare, which hosts the receiver, handles them in transit ([Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/)).

## Choosing whether to send, and stopping

You choose in the second step of the setup screen, which a new installation opens on. The checkbox there starts checked; uncheck it and nothing is sent. Nothing is sent or counted until you choose; without a choice (for example in a workspace made before the setup screen existed), nothing is sent and the screen does not ask.

To change your choice later, use the "Send usage data to help improve alpacawork" switch in Settings → General. Turning it off stops sending; turning it on starts it. If you only want to stop, you can also run `alpacawork telemetry off`.

When you stop, data not yet sent is deleted without being sent. Data already sent isn't deleted just by stopping ("Delete what was sent" below).

If you update to a version that adds a kind of information to what is sent, or changes how it is sent, a window asks you to agree again when you open the screen, only if you had chosen to send. It lists the fields added. Nothing is sent or counted until you answer. Each kind of information is a field of the report (for example `shape.tasks`); your choice records the fields it covered, so a field added later is always asked about. A new kind of action, or a new value of an action's attributes or of the kinds of AI (such as a new kind of AI), is counted without asking again.

In some cases, such as when alpacawork runs in CI or inside a container, nothing is sent even if you chose to send. The switch then can't be changed, and the reason appears under it.

Nothing is sent either while the environment variable `ALPACAWORK_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` is set for the server. The days the server ran with it are not sent after you remove it, either. Also, environment variables set in a terminal don't reach the server that starts automatically. To make sure sending stops, use the screen or the command.

## See what is sent

- Screen: "See what's sent" under the usage data switch in Settings → General shows today's draft, reports waiting to send, and the requests made by alpacawork. Each attempt records the destination, the exact content, and the result if known, including retries and in-app deletion requests.
- Command: `alpacawork telemetry show` shows the same history and the list of names and values that can be sent.

Each attempt is recorded before sending, and only what was recorded is sent, so the history shows exactly the destination and content that were sent. The record remains on this PC for 13 weeks, even if you turn sending off or ask to delete data at the receiver. If the response could not be recorded, the history shows that the outcome is unknown.

The `alpacawork telemetry` commands work only when a person types them in a terminal on this PC.

## Delete what was sent

- Screen: Use "Delete sent data" under the usage data switch in Settings → General. This works even after you have stopped sending. Data on the PC not yet sent is deleted too.
- Deletion page: Enter this PC's ID at <https://alpacakit-telemetry.alpacakit.workers.dev/delete>. Use it when you can't open the alpacawork screen, or to delete data from a PC you no longer use. You can find the ID in the window that "Delete sent data" opens, or as `id` in `alpacawork telemetry status`.

Deleting removes the reports sent with that ID and the record of that ID (the first and last days it sent). Data can't be removed from totals that don't tell PCs apart (such as the number of actions or of PCs per day).

Deleting doesn't stop sending. If sending continues, new data is sent with the same ID. The deletion page doesn't delete what is on the PC, so if that PC is still sending, stop sending first, then delete. Otherwise, the data not yet sent will be sent later.

## Where it goes, who can see it, and how long it is kept

- Where: The receiver the developer set up on Cloudflare Workers (`https://alpacakit-telemetry.alpacakit.workers.dev/v1/report`).
- Who: Only the alpacawork developer. The totals dashboard requires a login and shows the counts as they are, small ones included. When counts are published, groups of fewer than 10 PCs are left out, and the counts are labeled as coming only from PCs that chose to send.
- How long: Each report is kept with its ID for about 3 months, then deleted. The record of an ID is deleted about 3 months after the last day it sent. Totals that don't include the ID are kept indefinitely. They can't be traced back to individual PCs' reports.
