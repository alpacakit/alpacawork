<!--
Use repository-root paths for local files (docs/images/logo.png, LICENSE) so they open on every
branch. Link to the guides in this README with absolute GitHub URLs so the npm copy opens the
rendered guides and their section links. Put pictures in docs/images/. The package omits GIFs
and WebPs from that directory. Write links and pictures as inline Markdown links or as double-quoted src,
srcset or href attributes. Image descriptors in srcset are preserved.
Other forms of relative path are not rewritten for npm.
npm resolves no relative path, so the release rewrites each one in the packaged copy
(apps/backend/src/release/npm-readme.ts): a file the package carries opens from
https://unpkg.com/alpacawork@<version>/<path>. Pictures outside the package are served from
https://raw.githubusercontent.com/alpacakit/alpacawork/<release-commit>/<path>.
Other links outside the package open https://github.com/alpacakit/alpacawork/blob/main/<path>.
The setup guide an AI downloads uses a GitHub raw URL so the AI can read the Markdown directly.
GitHub plays a video only from the URL it gives when the file is uploaded on github.com, written on
a line of its own; it drops a <video> tag that points anywhere else. The packaged copy turns that
line into an explicit link to the video. To add a video, attach the file to a pull request comment
(gh pr comment --attach) and write the URL GitHub gives it.
The name at the top is a picture (wordmark.png, wordmark-dark.png for dark pages) so that it shows
larger than a heading can; its alt text carries the name.
The demo in the introduction uses synthetic data in the real app. It is an animated GIF with
transparent rounded corners (demo-dark.gif). The translated READMEs use demo-dark-<lang>.gif
with localized captions, diagrams, and closing cards.
The diagram at the top is drawn in each README's language (hero.gif, hero-dark.gif for this file;
hero-<lang>.gif, hero-dark-<lang>.gif for the others) and switches with the page theme in a <picture>;
its first and last frames are the finished picture.
README.ja.md, README.zh-CN.md, README.es.md and README.pt-BR.md are translations: keep all five with
the same sections and content, and change them in the same commit. Each links to the guides in its
own language (this file to docs/, the others to docs/ja/, docs/zh-CN/, docs/es/, docs/pt-BR/).
Each guide links back to the install heading of the README in its language (docs/getting-started.md
to README.md#install): keep those headings, or change the links with them.
-->

<p align="center">
  <b>English</b> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/wordmark-dark.png">
    <img src="docs/images/wordmark.png" alt="alpacawork" width="380">
  </picture>
</h1>

<h3 align="center">Run all your AI agents from one chat.</h3>

<p align="center">
  Write a request. AI agents on your machine, such as Claude Code and Codex, split it into tasks and run them in parallel.<br/>
  You answer their questions and check the results. It works from your phone too.
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="https://github.com/alpacakit/alpacawork/blob/main/docs/getting-started.md">Getting started</a> ·
  <a href="https://github.com/alpacakit/alpacawork/blob/main/docs/concept.md">How it works</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/alpacawork"><img alt="npm" src="https://img.shields.io/npm/v/alpacawork?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.gif">
    <img src="docs/images/hero.gif" alt="A request typed into one input box goes to the coordinator, which adds tasks to three projects (Website, Mobile app, Marketing) and places an AI such as opus · high or gpt-5 · high on each; one task asks a question, you answer, and every task finishes" width="640">
  </picture>
</p>

## What is alpacawork?

alpacawork brings AIs together to get work done. It's a task-based AI orchestration tool that lets you direct the Claude Code and Codex you already use from one chat box.

Ask the AI in that chat, called the coordinator. It checks how the work is going and passes instructions to the AIs doing it. You can leave the work of splitting up tasks and writing detailed instructions to the coordinator.

<p align="center">
  <img src="docs/images/demo-dark.gif" alt="A diagram beside the app shows a single request becoming three options that Claude and Codex work on in parallel. Changes go through the same chat. When an AI hits its usage limit, another picks up from the task record. A long conversation is compacted or restarted. You answer by picking an option, then review the result on your phone and swipe right to finish." width="800">
</p>

### No need to switch chats

Use the same chat box for new requests, additions, and changes to work in progress. The coordinator turns each request into a task and delegates it. It can direct work across several [projects](https://github.com/alpacakit/alpacawork/blob/main/docs/projects.md#add-projects).

### Use the Claude Code and Codex you already have

Start in your usual repository with your current logins. alpacawork needs no separate account or API key. `AGENTS.md`, `CLAUDE.md`, skills, MCP, and hooks work as usual. GitHub Copilot, Grok Build, and pi for local models are also supported ([AIs to use](https://github.com/alpacakit/alpacawork/blob/main/docs/projects.md#ais-to-use)).

### Runs on your PC

Like Claude Code and Codex, alpacawork runs on your PC. It stores tasks, conversations, and deliverable files there and does not send them to its own external servers ([How your data is handled](https://github.com/alpacakit/alpacawork/blob/main/docs/manage.md#where-your-data-is-and-what-is-sent-out)).

### Switch AIs and pick up where work left off

If an error or usage limit stops an AI, switch to another, for example from Claude Code to Codex, and continue from where it left off ([Tasks that stopped](https://github.com/alpacakit/alpacawork/blob/main/docs/guide.md#tasks-that-stopped)). If you've chosen a [fallback AI](https://github.com/alpacakit/alpacawork/blob/main/docs/projects.md#choose-a-model), it starts automatically when a usage limit stops the work.

### The AI starts fresh when a conversation gets long

Research shows that as conversations get longer, AIs are more likely to overlook instructions or make wrong assumptions ([Li et al. 2024](https://arxiv.org/abs/2402.10962), [Laban et al. 2025](https://arxiv.org/abs/2505.06120)). In alpacawork, the AI decides when to compact the conversation or start a new one from the key points in the task record.

### Describe the workflow in your own words

Give instructions in chat. There's no complicated setup. For example, “Make three proposals, each with a different model. Combine them and have another AI review the result.” You can choose which models to use and how several AIs should work together ([Say how to work in words](https://github.com/alpacakit/alpacawork/blob/main/docs/concept.md#say-how-to-work-in-words)).

### Keep work moving from your phone

Make requests, answer questions, and check results from your phone. Swipe to act on what comes in ([Use it from your phone](https://github.com/alpacakit/alpacawork/blob/main/docs/remote.md#use-it-from-your-phone)).

### Answer questions by picking an option

When the AI needs your decision, it sends a question with options and a recommendation. It can attach screenshots of the updated screen or a recording of how it works so you can decide.

### Tasks, not conversations

Your screen lists the tasks you asked for. Information is organized by task automatically, making it easier for you and the AIs to keep the work moving ([How it works](https://github.com/alpacakit/alpacawork/blob/main/docs/concept.md#work-moves-by-task-not-by-conversation)).

## Install

Paste the following text into Claude Code or Codex on your PC. The AI installs alpacawork and tells you the URL of the setup screen, which usually opens in your browser too.

```text
Download the guide below, read all of it, and follow it to install alpacawork on this PC.
https://raw.githubusercontent.com/alpacakit/alpacawork/main/skills/alpacawork/references/setup.md
```

To install with commands, run these two lines in a terminal (on Windows, inside Ubuntu), in order. Setup lists what it will set up and starts when you press Enter.

```sh
npm install -g alpacawork
alpacawork setup
```

It runs on macOS (Apple silicon), Linux (x64) and Windows (WSL2). After installing, follow [Getting started](https://github.com/alpacakit/alpacawork/blob/main/docs/getting-started.md) to make your first request.

### Open the screen

To open the screen in your browser, ask Claude Code or Codex like this (`$alpacawork` in Codex).

```text
/alpacawork open the screen
```

In a terminal, `alpacawork open` also opens it.

## Good to know

- **It is free (MIT License).** AI usage is billed under your existing Claude Code, Codex or other plan.
- **It runs on your PC.** Keep the PC on and set it not to sleep while you use alpacawork.
- **It starts AI agents in the same no-approval mode as Claude Code's `bypassPermissions` and Codex's `danger-full-access`, so they don't stop to ask.** You can write what the AI should not do, or should ask you about first, in the [project policy](https://github.com/alpacakit/alpacawork/blob/main/docs/projects.md#project-policy).
- **Tasks, conversations and result files are kept on your PC.** alpacawork does not send them to any outside server run by its developers. Your instructions to the AI, and what the AI reads, are sent to the AI's provider, just as when you use each AI agent directly ([more on how data is handled](https://github.com/alpacakit/alpacawork/blob/main/docs/manage.md#where-your-data-is-and-what-is-sent-out)).

## Documentation

- [Getting started](https://github.com/alpacakit/alpacawork/blob/main/docs/getting-started.md): install, make one request, and check it
- [Documentation home](https://github.com/alpacakit/alpacawork/blob/main/docs/README.md): every page, including how to use it, settings and troubleshooting
- Please report bugs in [Issues](https://github.com/alpacakit/alpacawork/issues)
- Release announcements are posted on X at [@codemafia0000](https://x.com/codemafia0000)

## License

[MIT License](LICENSE)
