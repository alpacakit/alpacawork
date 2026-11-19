# The ideas behind alpacawork

This page explains what alpacawork is for, how one request moves through it, and the thinking behind its design. It is for people who want to understand the ideas and get more out of alpacawork. For step-by-step instructions, see [Getting started](getting-started.md).

## What it solves

When you give several jobs to AI agents at once, the work of managing them falls to you: remembering what you asked where, checking on each one's progress, and deciding who does what. alpacawork hands that work to the AI. You say what you want done, answer the AI's questions, and check what it made.

## Why it was made

There are already many services that let you give instructions to the AI on your PC from your phone, Claude and ChatGPT among them. But they all assume you do the work at your PC. On a phone, you can mostly only do supporting tasks, such as checking progress or asking for small fixes. Following the work and reviewing results on a small screen was more stressful than I had imagined. That is why I started building alpacawork.

I designed alpacawork from the start for getting work done from a phone. So you don't have to track every step on a small screen, AI manages the tasks and the other AI agents, and you only talk to one AI, the coordinator, your point of contact.

## How it works

<p align="center">
  <img src="images/how-it-works.svg" alt="You say what you want done to the coordinator, the AI that is your point of contact. The coordinator sorts it out and passes it to an owner, the AI responsible for a task. The owner splits the work into child tasks, each with its own owner, and asks members for help. Questions and results to check come back to you." width="520">
</p>

Suppose you ask, "Build a booking form for the shop's site."

1. **Every request goes to the coordinator, the AI that is your point of contact.** New work, and additions or changes to work under way, all go in the same chat box. Ask "What's under way right now?" and it tells you.
2. **The coordinator looks at the work already under way and decides how to proceed.** It decides whether to add the request to a task already under way, make it a new task, or start it after other tasks finish, then hands it to the AI that owns the task (the owner). If it is unsure, it checks with you. The chat is ready for your next request right away.
3. **The owner sees the task through to the end.** It splits the work into smaller tasks, such as "Decide the booking fields", "Build the entry screen", "Write the email sent after booking" and "Check how it looks on phones", and hands each to a suitable AI. Parts that don't depend on each other run side by side.
4. **It becomes your turn when your judgment is needed.** What the AI can't decide on its own (for example, which fields the booking form should have) comes to you as a question with options, reasons and a recommendation. When the work is finished, it appears under "Awaiting review" with a report; check it and mark it done, or describe what needs changing and send it back. If an AI's run fails and stops, that is also your turn. alpacawork can notify your phone whenever it becomes your turn.

Each task's history records who asked for what and what each AI did, so you can trace what happened later.

The model and effort you choose in the input box apply to the coordinator. You set the owners' models in the project policy or in your request ([Ask](getting-started.md#ask)).

![One request split into child tasks, each worked on by a different AI](images/tree-desktop.png)

The owners are the AI agents on your PC themselves, such as Claude Code and Codex. alpacawork adds no AI of its own; it keeps the record of tasks and passes work to and from the AI.

## The parts

| Name | Description |
| --- | --- |
| Project | A body of work, with the folder the AI works in and the ground rules for the AI (the project policy) |
| Task | One job. The AI splits a big job into child tasks |
| Coordinator | The AI that is your point of contact. It looks at the work under way, decides whether a request becomes a new task or joins a current one, and passes it to an owner |
| Owner | The AI responsible for the result of one task |
| Member | An AI an owner calls in to help |
| Your turn | A state that can't move forward until you act: a question, a result to check, an AI's run that failed and stopped, and so on |

## Design principles

### It doesn't do more than it needs to

alpacawork handles task management and the mechanics of passing work to the AI and getting the results back. It doesn't dictate the details of how the AI works or how it reports. To have the AI work your way, write what you want in the project policy or `AGENTS.md`, or put the steps in a skill as you already do with your AI agent ([Say it in words, not settings](#say-it-in-words-not-settings)).

The skills, MCP and `AGENTS.md` you use now keep working unchanged, and the environment you have built up benefits the AI working in alpacawork too. Nothing sits in between to watch or stop what the AI does, so no extra time or tokens are spent on that.

### People only decide and check

The AI decides how to proceed, who does what, and how to check the work. It also handles the management: the order between tasks, whether to continue an owner's conversation or start a new one, and whether to hand the work to another AI. You can keep making requests in the same input box without checking progress or order to work out who should do what.

Only what you alone can decide comes to you.

- Questions about preferences and direction (with options, reasons and a recommendation)
- Checking what was made
- Approving operations with outside effects (such as publishing or deleting)

The ground rules say when the AI should ask you; no mechanism enforces them ([Write the ground rules for the AI](getting-started.md#4-write-the-ground-rules-for-the-ai)).

### Only what you use is on the screen

What isn't used isn't built or shown. You can ask the coordinator in plain words for most operations, such as changing settings, creating a project and updating, so few buttons and forms are needed for individual jobs.

The screen centers on what was made and what needs your judgment. Your requests are listed by state, so you can see what is moving and what is waiting for you. You can open the detailed back-and-forth with the AI when you need it.

Because the screen holds only what you use, it fits comfortably on a phone.

### Say it in words, not settings

Write what you want the AI to do in plain sentences, not through settings.

- **Project policy**: Ground rules that reach every owner in the project. Write things like "For changes to the look, show a sample before building" or "Run only the tests for the area that changed". The more you say about what the AI may decide and what it should ask you about, the fewer questions you get.
- **`AGENTS.md`, `CLAUDE.md`**: As usual, the AI reads the ones in the project's working folder.

Requests for the job at hand are plain sentences too. For example:

- "Do this with Claude Code's opus, at high effort"
- "Have Claude Code and Codex each draft a version, then compare them for me"
- "I want this finished quickly, so split the work and run the parts in parallel"
- "When it's done, have a different model from the one that built it check it"
- "Run only the tests related to the change"
- "The AI working on this seems to have gotten confused; switch to a new AI and carry on"

When the owner is replaced, decisions and results stay in the task's records, so the new AI picks up from there. Put what you always want in the project policy (for example, "Implementation with Codex, checking the results with Claude Code").

## What it is not for

- **Team use**: It is a tool for one person. For now, the screen has no login and there is no way to separate users.
- **Exposing it to the internet**: It assumes other devices connect through a VPN that only your own devices are on ([Use it from your phone](getting-started.md#5-use-it-from-your-phone)).
