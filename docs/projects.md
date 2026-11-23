# Fit it to your work

How to set up projects, the policy and the AIs to use. The AI changes any of the settings here if you ask in the input box (except signing in to the AIs and setting API keys, which you do yourself).

## Use it with an existing repository

Make the repository's folder the project's "Working folder". You don't need to move anything. The AI reads the folder's `AGENTS.md` and `CLAUDE.md` as usual.

To change it later: the project name at the top left → "(project name) settings…" → "Choose" under "Working folder" → "Save".

The AI changes files without asking for confirmation. If you commit before you start, you can tell the AI's changes apart and undo them.

## Add projects

Make one project per repository. Press the project name at the top left → "New project", enter a name and a working folder, and press "Create".

When a request does not say which project it is for, the AI chooses one by each project's name and "Summary", one sentence on what the project is for. The AI writes the summary itself the first time it puts a request in the project. You can change it in the project's settings.

You can archive a project you no longer use from the bottom of the project's settings.

## Project policy

In "Project policy" in the project's settings, write in plain sentences what the AI may decide on its own, what it should ask you first, and what it must not do. It reaches every AI in that project.

It serves basically the same purpose as `AGENTS.md`. Write in the project policy the instructions you want the AI to read only when it works through alpacawork.

```text
Goal: Make the shop's site easy to read on phones, and publish it
How to work: For changes to how it looks, show me a sample and ask before building
Leave to the AI: How to proceed, testing and cleanup; decide without asking and report
Don't: Push to GitHub or publish without my approval
```

The policy is an agreement with the AI, not something a mechanism enforces. To limit what the AI can reach at all, use a separate PC or OS user for the work.

## AIs to use

| AI agent | What it needs |
| --- | --- |
| Claude Code, Codex | A sign-in through each one's CLI |
| GitHub Copilot | A GitHub CLI sign-in (`gh auth login`). The agent itself is bundled |
| Grok Build, pi | A sign-in or an API key |

Turn on the AIs to use under "Agents" in "Settings (the gear) → Server", and press "Save". To split work between AIs, write it in the policy ("Codex for implementation, Claude Code for review").

Your current AI plans and settings are used as they are. Usage is billed under those plans.

## Choose a model

The model you choose beside the input box is the coordinator's. For the AIs that take on tasks, name the model in your request or in the policy ("Do this work with opus").

To add a new model, open the AI's card under "Agents" in "Settings (the gear) → Server", add the model name to the `model` row of "Values available when requesting work", and press "Save".

## Pass an API key

Don't write keys in the input box or on the screen; write them in a file yourself.

1. Check where the file is under "Environment file" at the very bottom of "Settings (the gear) → Server" (usually `~/.config/alpacawork/env`).
2. Write one per line, like `ANTHROPIC_API_KEY=...`, and make the file unreadable to other users: `chmod 600 ~/.config/alpacawork/env`
3. Restart alpacawork ([Stop and start](manage.md#stop-and-start)).
4. Check that the name is in "Additional environment variables" on the AI's card. If it isn't, add it and press "Save".

## How many run at once

At first, up to 8 AIs run at the same time. If that uses up too much of your plan's limits, lower "Max concurrent runs" under "Settings (the gear) → Server" → "Advanced options", and press "Save".
