# Getting started

This takes you from installing alpacawork to asking the AI for one thing and checking the result. It takes about 15 minutes, including the time spent waiting for the AI.

## Before you start

- Your PC needs to run macOS (Apple silicon), Linux (x64, with a systemd user session, which most desktop and server installs have) or Windows (WSL2 with systemd on, the default for Ubuntu). On Windows, read [On Windows](manage.md#on-windows) first.
- Have Claude Code or Codex ready to use on this PC.
- The AI changes files without asking for confirmation. It runs with your user account's permissions on this PC, so it can reach beyond the folder it works in.

## 1. Install

Paste the text below, unchanged, into Claude Code or Codex on your PC. The AI installs whatever is missing, then installs alpacawork. If it asks for permission to run a command, allow it.

```text
Download the following document, read all of it, and follow its steps to install alpacawork on this PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

To install it from your own terminal, install Node.js 24.16 or later, then run these two lines in order and press Enter when asked.

```sh
npm install -g alpacawork
alpacawork setup
```

## 2. Open the screen

When the install finishes, the screen opens in your browser. If it didn't, or you closed it later, ask Claude Code `/alpacawork open the screen` (in Codex, `$alpacawork open the screen`). The AI opens the screen in your browser or tells you its URL. You can also run `alpacawork open` in a terminal, or open the URL printed at the end, such as `http://127.0.0.1:43127/`, in your browser.

This URL stays the same even after you restart the PC. Bookmark it. alpacawork starts by itself when you log in to the PC, so you don't need to start it each time.

If you can't open it, see [The screen doesn't open](troubleshooting.md#the-screen-doesnt-open).

## 3. Choose a project

Go through the screen's four steps in order.

1. Choose the screen's language and theme, and press "Next".
2. Check that the AIs you will use are "On", and press "Next".
3. In the next step, keep the recommended choices and press the install button.
4. Name the project, choose your repository's folder as the "Working folder" if you use an existing one, and press "Finish setup".

<img src="images/setup-project.png" alt="The last step of setup, with the “Name” and “Working folder” fields and a “Choose” button beside the working folder" width="480">

A project is one folder for the AI to work in, together with the ground rules for working there (the project policy). To use an existing repository, make its folder the working folder. If you are only trying it out, leave the working folder empty (the AI works in the data folder, `~/alpacawork`). You can start with the example project policy as it is.

## 4. Send a request

Write what you want done in the input box at the bottom of the screen, and send it. Once sent, the start of the reply appears above the input box. Press it to read the whole reply.

<img src="images/input-reply.png" alt="The input box, with the start of the coordinator's reply above it" width="560">

In an existing repository, make your first request one that doesn't change any files.

```text
Read the contents of this folder and sum up what it is for in 3 lines. Don't change any files. Then suggest 3 pieces of work I could ask for next, and ask me which one to go ahead with.
```

The AI reads the folder and writes the summary and the suggestions in its reply (it may also make a task and ask you in a question). If it answers in a reply, send the one you want in the input box, like "Go ahead with 1", and it becomes a task with a row in the list.

If you are only trying it out, press the screen's example "Pick a mini game idea, then have it built", then send it.

While the AI works on a task, you don't need to watch the screen.

## 5. Check when it's your turn

When a question or a report arrives from the AI, the task moves to "Awaiting review". Open the task.

<img src="images/list-waiting.png" alt="The “Awaiting review” heading in the list, with a task row under it" width="336">

- For a question, press one option, then send it. Pressing alone doesn't deliver it. Once you answer, the AI carries on, and a report arrives when it is finished.
- For a report, read it, and if it is good, press "Done" (the check mark) at the bottom of the screen. If you want changes, write them in the input box and send.

<img src="images/action-bar.png" alt="The buttons along the bottom of an open task: “Auto-swipe”, “Change state” and “Done”" width="338">

Once the task moves to "Done", you are finished ("Done" starts collapsed; press the heading to open it). Send your next request from the same input box.

## What to read next

- [How to use it](guide.md) — everyday use
- [Fit it to your work](projects.md) — how to write the policy, which AIs to use
- [Troubleshooting](troubleshooting.md)
