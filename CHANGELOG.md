# Changelog

<!--
How to write a section. The release workflow publishes the section of the tagged version as the
GitHub Release text, and folds the full list of pull requests below it by itself.

- The pull request that changes the version in package.json is titled `Release <version>` (the folded
  list leaves it out) and adds a section at the top of this file, headed `## <version>` with the version
  exactly as in package.json (no "v", no date). `pnpm test:quick` fails while the current version has
  no section.
- Write in English.
- Read the pull requests merged since the previous version tag (titles and descriptions).
- Write for people who use alpacawork and decide whether to update: what they will notice and what
  they must do, in their words, not how it was built.
- Order:
  1. One or two sentences on what this version is about.
  2. An update line, as in the sections below.
  3. `### Check before updating`: only when something needs action (a removed or renamed option,
     a changed default, something to redo). Say what to do.
  4. `### Highlights`: up to five, each led by a short bold phrase.
  5. As needed: `### Setup`, `### Screens`, `### Fixes`, `### Faster`, `### License and security`.
     Leave out a heading with nothing under it.
- One line per change; join related pull requests into one line and cite them as ([#12](<url>)).
- Leave out what nobody using alpacawork notices: tests, comments, internal names, refactors,
  contributor tooling, and the version pull request itself.
- Do not edit a section after its version is released.
-->

## 0.1.5

Copilot can find your skills directly, and the coordinator shows the same message status whether its conversation is open or folded.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.5`. The database schema and Run execution format are unchanged from 0.1.4. From 0.1.0-beta.9 or earlier, follow the [older-beta update instructions](https://github.com/alpacakit/alpacawork/blob/v0.1.1/CHANGELOG.md#011), using `alpacawork@0.1.5` in step 4.

### Highlights
- **Copilot finds your skills at startup.** alpacawork gives Copilot your skills folder when a session starts or resumes. In local Linux tests, this shortened the wait for a new conversation to get ready. ([#22](https://github.com/alpacakit/alpacawork/pull/22))
- **Consistent coordinator status.** If you send a message while the coordinator is preparing, both the open conversation and its folded line say “Starting the coordinator.” ([#20](https://github.com/alpacakit/alpacawork/pull/20))

## 0.1.4

This release removes Antigravity (`agy`) support. The getting-started guide now includes the FAQ from the README.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.4`. The database schema and Run execution format are unchanged from 0.1.3. From 0.1.0-beta.9 or earlier, follow the [older-beta update instructions](https://github.com/alpacakit/alpacawork/blob/v0.1.1/CHANGELOG.md#011), using `alpacawork@0.1.4` in step 4.

### Check before updating

If you have an `agy` agent in your settings, delete it before updating. Open **Settings → Server**, choose **Delete agy**, and save, or ask in the chat, “Remove agy from settings.” If you gave a profile using `adapter: agy` a different name, delete that profile too. Leaving any of these profiles in your settings prevents alpacawork from accepting new requests after the update.

### Highlights
- **Antigravity support removed.** Google does not support running `agy` through third-party apps with a personal-plan sign-in. [Google Antigravity FAQ](https://antigravity.google/docs/faq) · [#19](https://github.com/alpacakit/alpacawork/pull/19)
- To use Gemini in alpacawork, set up pi with a Google Gemini API key. [pi provider setup](https://pi.dev/docs/latest/providers)

### Setup
- The answers about adding new models and asking the AI to change settings are now in the getting-started guide in all five languages. ([#18](https://github.com/alpacakit/alpacawork/pull/18))

## 0.1.3

An empty coordinator conversation now gives you examples you can try right there.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.3`. The database schema and Run execution format are unchanged from 0.1.2. From 0.1.0-beta.9 or earlier, follow the [older-beta update instructions](https://github.com/alpacakit/alpacawork/blob/v0.1.1/CHANGELOG.md#011), using `alpacawork@0.1.3` in step 4.

### Highlights
- **Four examples in the conversation.** Even when the conversation covers the welcome screen, its opening offers four examples and the app and phone link where available. ([#16](https://github.com/alpacakit/alpacawork/pull/16))

### Setup
- The Brazilian Portuguese README clarifies that you can edit the models yourself. The Spanish and Brazilian Portuguese FAQs use consistent quotation marks. ([#15](https://github.com/alpacakit/alpacawork/pull/15))

## 0.1.2

The first screen now shows how to use alpacawork on a phone or as an app. Links from the npm README take you straight to the relevant sections of the guides.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.2`. The database schema and Run execution format are unchanged from 0.1.1. From 0.1.0-beta.9 or earlier, follow the [older-beta update instructions](https://github.com/alpacakit/alpacawork/blob/v0.1.1/CHANGELOG.md#011), using `alpacawork@0.1.2` in step 4.

### Highlights
- **Find the app and phone setup on your first visit.** On a computer, the welcome screen or the opening conversation offers a one-time link to **Apps & phone** in Settings. That tab explains how to install the app on your PC or use alpacawork from your phone. ([#12](https://github.com/alpacakit/alpacawork/pull/12))

### Setup
- Guide links in the English npm README open the matching sections on GitHub, including requirements, phone setup, and troubleshooting. ([#13](https://github.com/alpacakit/alpacawork/pull/13))

## 0.1.1

alpacawork is now available in Simplified Chinese, Spanish and Brazilian Portuguese. First-time setup makes each step clearer, and task status looks the same wherever you open a task.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.1`. The database schema and Run execution format are unchanged from 0.1.0. From 0.1.0-beta.9 or earlier, follow the instructions for older beta versions in the [0.1.0 update notes](https://github.com/alpacakit/alpacawork/blob/v0.1.1/CHANGELOG.md#010), using `alpacawork@0.1.1` in step 4.

### Highlights
- **Three more languages.** Choose Simplified Chinese, Spanish or Brazilian Portuguese in Settings or during setup. On first use, alpacawork follows the browser or terminal language when supported. The interface, guides, notifications and terminal confirmations are available in all three languages. ([#2](https://github.com/alpacakit/alpacawork/pull/2))
- **Clearer first-time setup.** See where you are in the three steps, which agents are on, and where the AI will work. The welcome screen shows how to set a project rule and a limit on parallel agents. The snake game example can vary the effort when fewer than three models are available. ([#4](https://github.com/alpacakit/alpacawork/pull/4))
- **Consistent task status.** A task uses the same icon, color and label in the list, task tree, search and other task views. A working task with nothing running on it or below it shows a gray pause icon and “Waiting.” ([#1](https://github.com/alpacakit/alpacawork/pull/1))

### Setup
- In all five languages, the README puts installation near the top and links to the guides in the same language. A new FAQ explains how to ask the coordinator to add a new model or change settings. ([#3](https://github.com/alpacakit/alpacawork/pull/3), [#5](https://github.com/alpacakit/alpacawork/pull/5), [#6](https://github.com/alpacakit/alpacawork/pull/6), [#7](https://github.com/alpacakit/alpacawork/pull/7), [#8](https://github.com/alpacakit/alpacawork/pull/8))
- The README's copyable install instructions link directly to the setup guide on GitHub in all five languages. ([#11](https://github.com/alpacakit/alpacawork/pull/11))
- The npm package description and keywords now match how the README and GitHub introduce alpacawork. ([#10](https://github.com/alpacakit/alpacawork/pull/10))

### Screens
- In project settings, **Working folder** is the new name for **Code location**. ([#4](https://github.com/alpacakit/alpacawork/pull/4))

## 0.1.0

This is the first release without the beta label. The welcome screen of a new project now leads with an example in which three models build a snake game for you to choose from, agent settings omitted from `config.yaml` follow each version's defaults, and a task's History stays smooth while agents work.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.0`. The database schema and Run execution format are unchanged from 0.1.0-beta.12. From 0.1.0-beta.9 or earlier, follow "Check before updating" under 0.1.0-beta.10 with three differences: install `alpacawork@0.1.0` in its step 4; in its step 6 the list shows the data folder as `(existing)` and asks `Proceed? [Y/n]`; and in its step 7 `alpacawork skills update` brings back alpacawork-betterquality only. If the uninstall's list in step 3 names alpacawork-majority or alpacawork-try-and-keep and you still use them, make sure you can get them elsewhere before you confirm: they are no longer part of alpacawork (see 0.1.0-beta.11).

### Highlights
- **A welcome you can try in a few minutes.** The first example on the welcome screen of an empty project asks three different models to build a snake game in parallel and then asks you which one to keep; the work starts when you send it. A second example picks a mini game idea first and has it built after your answer.
- **Agent settings follow the built-in defaults.** A model, effort or environment setting that is not written in `config.yaml` uses the default of the version you run, so a new default reaches existing workspaces too. This includes `env`: an agent whose `env` is left out now gets the default extra environment variables, so write `env: []` to pass none. Settings → Server marks the rows that follow the default and, on a row with a default whose value was changed or written, offers "Restore default". The update does not rewrite an existing `config.yaml`.

### Setup
- The default Codex models are `gpt-6.2-sol`, `gpt-6.2-astra` and `gpt-6.1-terra`. A workspace whose `config.yaml` lists its own models keeps them.
- The setup guide gives the Tailscale install command for macOS, Windows and Linux, so the AI that installs alpacawork can hand you the exact command.
- The AI that installs alpacawork writes in the language you write in, and says only why a step is needed and what to do.
- askmeclearly and doyourjob still download from `alpacakit/pocket-skills`, which is not public yet. Installing them in setup fails for anyone without access; skip them and go on. This is unchanged from 0.1.0-beta.12.

### Screens
- In a task's History, rows glide to their new place while an agent works, when a subtask finishes and when a question is answered, instead of jumping.
- On a computer, the coordinator's input and conversation stay left of a file or diff opened beside a task, instead of covering it.

### Fixes
- An opened task no longer shows its reload indicator again and again while an agent is only producing output.
- A first message sent while the coordinator is getting ready appears at the top of the conversation, without a blank gap above it.

## 0.1.0-beta.12

Settings now brings the desktop app, phone access and notifications together in one guide. This version also keeps working subtasks visible on the home list and improves reading beside the coordinator.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.0-beta.12`. There are no database or data format changes. From 0.1.0-beta.9 or earlier, follow "Check before updating" under 0.1.0-beta.10 with two differences: install `alpacawork@0.1.0-beta.12` in its step 4, and in its step 6 the list shows the data folder as `(existing)` and asks `Proceed? [Y/n]`.

### Setup
- askmeclearly and doyourjob still download from `alpacakit/pocket-skills`, which is not public yet. Installing them in setup fails for anyone without access; skip them and go on. This is unchanged from 0.1.0-beta.11.

### Screens
- **One guide for the app, phone and notifications.** Settings → App & phone (formerly Open on phone) shows how to install the desktop app, open alpacawork on your phone and turn on notifications, with browser-specific instructions. Phone connection includes a prompt to copy to your PC’s AI, with manual steps folded below it.
- On a computer, the coordinator's input and conversation narrow beside the reader as you widen it, then widen back when you make room again.
- The folded On hold heading no longer repeats its task count as a separate “Your turn” count.

### Fixes
- A working subtask appears under In progress even when its parent awaits your answer or review, is on hold or has failed. Work already shown by an In progress parent is not listed twice.
- On a phone, tapping a report's video or words takes focus out of the coordinator's input, allowing the keyboard to close. Tapping an empty part of a video's native controls bar can still leave the focus in the input.

## 0.1.0-beta.11

A new workspace now opens on a three-step setup (agents, recommended skills, first project) and then a welcome screen with examples to try, and installing takes one sentence pasted into an AI. Screens also keep up on large workspaces: a change reaches the list sooner, and writes no longer slow down as history grows.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.0-beta.11`. From 0.1.0-beta.9 or earlier, follow "Check before updating" under 0.1.0-beta.10 with two differences: install `alpacawork@0.1.0-beta.11` in its step 4, and in its step 6 the list shows the data folder as `(existing)` and asks `Proceed? [Y/n]`.

### Highlights
- **Three-step setup for a new workspace.** Choose the agents to use, install the recommended skills (askmeclearly, doyourjob, alpacawork-betterquality), and write the first project's policy from an editable default; a welcome screen with three examples follows. An existing workspace is not shown the setup.
- **Install by asking an AI.** The README now gives one sentence and a link to paste into an AI agent; the agent installs alpacawork and runs setup itself, without step-by-step approvals. Signing in to agents and the choices on the setup screen stay with you.
- **Faster on large workspaces.** Screens no longer wait for the whole project to be rebuilt after a change, and saving a change stays quick however long a task's history is.
- **Agents keep to your language.** Every AI conversation, members and continued conversations included, is told the language to reply in.
- **A member's result in History.** Each Request an owner sent to a member shows the reply folded under it.

### Setup
- A new workspace makes the usage data choice in setup's first step; the separate consent dialog is gone, and the setting sits at the end of Settings → Server.
- askmeclearly and doyourjob are downloaded from `alpacakit/pocket-skills`, which is not public yet. Until it is, installing them in setup fails for anyone without access to it; skip them and go on.
- The majority and try-and-keep add-ons are no longer part of alpacawork. Copies you installed stay as they are; `alpacawork skills update` updates the alpacawork and alpacawork-betterquality skills.
- The alpacawork-betterquality skill is rewritten: a clearer structure, reviews sized to the weight of each decision, a new agent for work that stops converging, and no retrospective part.
- `alpacawork setup` takes `--lang <tag>` and `-y`/`--yes`, and opens the screen in your browser when it finishes (`--no-open` to skip); `alpacawork uninstall` takes `-y`/`--yes`.
- The alpacawork skill says when an owner does the work itself, asks a member, or makes a child task.
- The README and guides are rewritten, with new pictures that show alpacawork on a PC as well as on a phone.

### Screens
- Every section of the home list opens and closes from its heading and is remembered, and rows keep their order when tasks change sections.
- A question card's choices can be picked, and the next message sent, while the coordinator is still answering.
- The mark beside a task's ID now puts the task's label into the input instead of copying the ID and title.
- The coordinator's conversation is tighter and leaves more room on a phone.
- History jumps glide to their row, and its marks sit on the rail at any zoom.
- The phone's offline sheet has one close button and a shorter text.
- A browser too old for the screen shows why instead of a blank page.
- Done, a question's choices and the send buttons no longer blink disabled during short waits; they dim only when a wait lasts a second.

### Fixes
- A fenced code block under a list item shows as code.
- The folded history of the coordinator's conversation counts messages instead of flashing "unread".
- The reading line in a task shows only while a read keeps someone waiting.
- A next-day expected report no longer widens the time view, and rows keep their height as the axis moves.
- The all-answered summary counts per round without repeating the total.
- The first message to a coordinator that had not started yet is no longer lost.
- "Sending soon" stays beside Undo in the folded conversation row while a message waits to be sent.

### License and security
- The usage data page now says that the developers' own totals dashboard, which only they can open, shows small counts as they are. Counts published outside still leave out groups of fewer than 10 PCs.

## 0.1.0-beta.10

Notifications now start 30 seconds after you leave the screen, a task's Files tab lists what you are meant to open apart from the agents' working files, and the README and guides are in English with Japanese versions beside them. Moving to this version from 0.1.0-beta.9 or earlier takes an uninstall and a new setup over your data instead of an update: read "Check before updating" first.

**Update:** not with Settings → Update or `alpacawork deploy` this time. From 0.1.0-beta.9, uninstall and set up again over your data, as "Check before updating" describes.

### Check before updating
- **Settings → Update does not offer this version, and `alpacawork deploy` cannot install it.** It describes its records of the installation and of updates in a new form that 0.1.0-beta.9 and earlier do not accept. On 0.1.0-beta.9, Settings keeps showing the version you have, `alpacawork deploy npm:alpacawork@0.1.0-beta.10` stops with `npm candidate could not be inspected: metadata_unknown`, and a deploy from a repository stops with `Unsupported target update capabilities`. Your installation and data are left as they were, and the version you have keeps working.
- **From 0.1.0-beta.9, uninstall and set up again over the same data folder.** Run these in a terminal, in order.
  1. Ask the coordinator to put the tasks with working agents on hold, and wait until none is working; the uninstall is refused while an agent is working. Then run `alpacawork workspace url` and note the port in `localUrl` and, if `publicUrl` is not `null`, the host in it with its port (`pc.example.ts.net:8443` from `https://pc.example.ts.net:8443/`). The new setup needs them to keep the same addresses.
  2. If `~/.config/alpacawork/` holds `env` (keys for agents) or `telemetry.json` (your usage data choice and this PC's ID), copy them to another folder with `cp -p`. The next step removes that folder.
  3. `alpacawork uninstall`, before you install the new version. Read its list of what it removes and keeps, note the folder on the "Keep Data" line (`~/alpacawork` unless you chose another), then press Enter. You do not need the `npm uninstall -g alpacawork` it shows at the end.
  4. `npm install -g alpacawork@0.1.0-beta.10`
  5. Put back the files from step 2: `mkdir -m 700 ~/.config/alpacawork`, then copy them into it with `cp -p`.
  6. `alpacawork setup --workspace <data folder> --port <port>`, adding `--public-host <host>` if step 1 gave one. Its list shows the data folder with "use existing data unchanged". Press Enter, then open the URL it shows.
  7. If you had installed the add-on skills, run `alpacawork skills update`; it installs all three again. Then ask the coordinator to resume the tasks you put on hold.

  The data folder is kept: your tasks, their values and history, Run results and `config.yaml`. Setup makes the automatic start, the program files and the alpacawork skill anew. Edits you made by hand to the skills the uninstall removes are lost; skills of your own are kept. Without step 5, agents start without the keys in `env`, the screen asks about usage data again, and choosing to send gives this PC a new ID, so what was sent under the old one can no longer be deleted from Settings.
- **From 0.1.0-beta.8 or earlier, update to 0.1.0-beta.9 first** (its release notes give the command), then follow the steps above.

### Highlights
- **Notifications start sooner after you leave.** You now count as away 30 seconds after the screen you last touched is hidden (another app, another tab or a locked phone), not only once the "Away when idle" time has passed. A result that arrives just after you switch away is pushed to your phone instead of waiting for minutes. Coming back within the 30 seconds keeps you present, and nothing changes while the screen stays in view.
- **The Files tab shows deliverables.** A task's files are split in two: Deliverables are the files the task's Deliverables field links, wherever they are, plus documents, images, videos and audio outside `work/`; Work files are the rest, which only agents use. The tab's number and its first list count the deliverables, with the linked files first under the names written in the field. "All" and "Other" are gone.
- **The coordinator's wait is counted in seconds.** Beside what the coordinator is doing, its message shows the time since you sent yours: "Command 32s" instead of "Command ×2".
- **Close a phone's task sheet by your thumb.** A round down-arrow above Done closes the task sheet, the same arrow that closes the conversation sheet, so you no longer reach for the × at the top.

### Setup
- The README and the guides (Getting started, The ideas behind alpacawork, Usage data) are now in English, with the Japanese versions in `README.ja.md` and `docs/ja/`. "Before you start" is part of Getting started.
- The usage data page is cut down to what you need to decide whether to send usage data, to stop it and to delete what was sent. Its per-field tables are gone; Settings and `alpacawork telemetry show` show the exact report.

### Fixes
- Clearing the coordinator's conversation no longer leaves it at "Could not start the coordinator." when one of the chosen launch options is left out, such as Codex without fast.
- A proposal you asked for now reaches you as a question you can answer: the alpacawork skill has an owner ask for your choice instead of reporting the task done with the choice written in its report.

## 0.1.0-beta.9

The update screen now says which version it installs, what changes and whether agents must finish first, and gives you an instruction for the coordinator to pause them. HTML inside Markdown documents is now drawn safely, as GitHub draws it.

**Update:** Settings → Update, or `alpacawork deploy npm:alpacawork@0.1.0-beta.9`

### Check before updating
- This version changes how Runs work with the server, so it installs only while no Run is unfinished. Before pressing Update, ask the coordinator to put the tasks with working agents on hold and let the running ones finish what they are doing; Update goes through once none is working. After the update, ask the coordinator to resume them. Do not cut running work short to get it through, and do not go back to an earlier version afterwards.
- Requests from an `alpacawork` command on another PC that does not match this server's CLI contract, as any from 0.1.0-beta.8 or earlier, are refused. When a command reports `CLI contract mismatch`, run the repair command shown in that error on that PC; it installs the server's version of the command and its skills. Then send again. If that PC runs its own server too and the refusal continues, update that server to the same version.

### Highlights
- **The update says what it installs.** Settings shows the new version next to the one you have, with a link to its release notes, and Update sits on that line. The confirmation shows "current → new", the notes link, and that you cannot go back afterwards. Progress names the version being downloaded, and a failure says whether the network or the disk was the cause and what to do.
- **Pausing agents for an update.** A version that needs every agent to finish says so before you press anything and offers "Copy the pause instruction": send it to the coordinator, which puts the working tasks on hold and lets running agents finish their turn. Update appears once none is working, and the finished update reminds you to ask the coordinator to resume them.
- **HTML in Markdown.** Supported HTML such as `<p align="center">`, `<b>`, `<details>`, tables and links is drawn as GitHub draws it; scripts, unsafe links and other tags are not, and web images still show their alt text instead of being fetched. On a phone, documents now offer the rendered/source choice too.

### Screens
- The empty project's start examples stand on a surface of their own, so the words above them no longer look like a row to tap; the conversation's opening examples look the same.
- The "No projects to show" page no longer flashes before the list loads.

### Fixes
- Retry on a failed task no longer shows an error after it has worked. A press that did not go through says "Your instruction for … didn't go through" with the task's ID and title, instead of calling every press an answer.
- A completion report must now have a body, so History always says what was done.
- The coordinator chooses its reply language the same way on the screen and in a conversation outside it.

## 0.1.0-beta.8

GitHub Copilot joins the supported agents, a new setup turns on only the agents that are signed in, and an agent that runs its own CLI can run the executable you choose. Six agent kinds are no longer supported. On a phone, the small sheets now close by their × and by their grip.

**Update:** Settings → Update, or `npm install -g alpacawork@0.1.0-beta.8`

### Check before updating
- opencode, Hermes, goose, Qwen, Amp and DeepSeek Harness are no longer supported. Before updating, delete every profile of kind `opencode`, `hermes`, `goose`, `qwen`, `amp` or `deepseek`, in Settings → Server or from `config.yaml` in the data folder. If one is left, alpacawork refuses to read its settings and names the kind and its YAML line until you remove it; it does not edit the file for you. Run history of those kinds stays readable.
- This version changes how Runs are recorded, so it installs only while no Run is unfinished. Do not stop Runs to get it through: update once they have ended on their own. After the update has finished, do not go back to an earlier version.

### Highlights
- **GitHub Copilot.** Copilot can now be an agent. It runs on a copy bundled with alpacawork and signs in through the GitHub CLI (`gh auth login`). It was checked on Linux. The supported agents are now Claude Code, Codex, GitHub Copilot, Grok Build, Antigravity and pi.
- **Only signed-in agents start on.** A new setup lists the agents it finds but turns on only those it can confirm are signed in: Claude Code, Codex and Copilot. Grok Build, Antigravity and pi start off until you turn them on. Settings you already have are not changed.
- **Choose an external agent's executable.** In Settings → Server, an agent that is signed out or whose executable is missing says what to do next. Open an agent that runs its own CLI to see the executable it runs and pick another one on the server's PATH (with its version), or enter an absolute path; in `config.yaml` this is `command`. A path that is missing or cannot run is refused, and alpacawork does not fall back to another one. Copilot runs only its bundled copy, so it has no executable to choose and `command` is refused for it. `alpacawork config get --check` shows each agent's sign-in state within 10 seconds, and for an agent that runs its own CLI also its executable, version and other candidates.
- **Phone sheets close like the others.** The model picker, the project menu, notification settings, the report input and the offline notice now have a visible × on a phone and close when their grip is pulled down. Their content scrolls under the head, so the × and the grip stay in reach in a long list.

### Setup
- On Windows 11 with WSL2, first setup is no longer refused as if alpacawork were in a sandbox. Data or settings in a Windows folder such as `/mnt/c` are refused with an explanation, in English or Japanese, before anything is written.
- `alpacawork uninstall` works after an update from the screen, also when the npm-installed launcher is older, and a later `alpacawork setup` picks up the same data again. Your database and files are kept. Changing an installed service's port with `alpacawork setup` no longer fails on a connection left open by its own check.
- The README covers what to know before installing, the first request from question to final report, and on WSL2, Node and the AI CLIs on the Linux side, nvm and keeping the terminal open. The setup guide your AI reads comes with the npm package.
- The README and the getting-started guide say that a phone or another PC opens the screen only through an HTTPS address, such as one from Tailscale Serve, and that notifications need it; a plain `http://` address shows a blank page or an error.

### Screens
- The Personal tab in Settings now says that its settings are shared by everyone using this server, and that only notification subscriptions belong to each device.

### Fixes
- Pressing **Send again** on a failed coordinator message no longer leaves another copy in the conversation each time: the message sent again takes the failed one's place, and the coordinator gets it once.
- An empty task list no longer draws its time lines across the first-request examples.

## 0.1.0-beta.7

A task's text files now open in the viewer that shows diffs, where they can be copied and downloaded, and GIFs, audio and more media show in a task. The coordinator says what it is doing while it works, and Settings, the model picker and the task list's time strips were redrawn.

**Update:** Settings → Update, or `npm install -g alpacawork@0.1.0-beta.7`

### Highlights
- **Text files open in the viewer.** A text file in the Files tab, or a link to one in a report, opens in the viewer that shows diffs: beside the file list on a wide computer, over the whole screen on a phone. Markdown, HTML and CSV files are drawn as documents, pages and tables (on a computer, with their source one click away); other text shows with line numbers and colours.
- **Copy and Download in the viewer.** An open file's head has Copy for its text and Download for the original file; a diff, or a file that cannot be read on the screen, has Download alone. The mark that copies the path now stands beside the path, and a table's own download mark is gone.
- **GIFs, audio and more media.** Reports and the Files tab show GIF, AVIF and other images, MOV video, and audio such as MP3 and WAV, and a report can embed them. A file the screen cannot show offers to save the original.
- **The coordinator says what it is doing.** While it works, its message names its recent work ("File read", "Web search", "Request to an agent ×2") instead of staying on "Working on it…".

### Setup
- The README and the guides are rewritten for first-time readers, with new pictures and a table of which document to read when. The getting-started page marks the notes meant for an AI that reads it to do the work for you.
- On npm, the README's pictures and links now work, and the package's description and keywords say what the repository says.
- From this version, a GitHub Release opens with what changed and what to check before updating, and folds the full list of pull requests below.

### Screens
- A dialog keeps its title, close button and tabs in place while its body scrolls, and Settings keeps one height from tab to tab. Every setting is one form of row, and the notification settings are switches instead of checkboxes.
- The model picker opens in line with its button on a computer and as a sheet on a phone, keeps each AI's name in view while its models scroll, and no longer marks models `default`. Its closed button names the AI only where two list the same model.
- The task list's time strips are calmer. A task waiting on you always shows when your turn began, or "From 10:30" at the strip's edge when that is off the screen; on a wide screen "now" is one line down the whole list; stretches where no one is at work are the quietest lines; and the row open in the reader is tinted.
- An empty project's starting examples each say what you will see. While they show, the conversation points to them; once a project has tasks, it offers four examples for ongoing work.
- On a phone, the grip at the top of the conversation sheet is twice as tall, and tapping it no longer shows the "Drag to resize" tip.

### Fixes
- On a phone, swiping a report and the app's other gestures no longer stop working after two fingers brush the screen and leave a zoom too slight to see.
- The buttons that open a task's state form no longer dim and turn off for a moment each time the connection is checked, for example when you come back to the tab.
- With only a file attached in the coordinator input, opening a task now puts that task's label in the input, and opening another switches it.
- Questions from agents repeat less: the alpacawork skill now has an owner show each picture and link once across a question's description and choices, and link what you can open, such as a pull request.

## 0.1.0-beta.6

Installation is now led by your AI, setup can change its port, public host and Node.js path later, and `alpacawork uninstall` removes an installation. Everything agents read is now in English.

**Update:** Settings → Update, or `npm install -g alpacawork@0.1.0-beta.6`

### Check before updating
- Sending a message from the reader no longer swipes its card away. Turn on the new Auto-swipe switch above the input to keep the old behaviour; a saved pin is not carried over.
- The launch prompt, the alpacawork skills and the field texts agents read are now English. The Japanese screen is unchanged.
- A question's recommended choice, its stop choice and "other" are now written as parts of the question, not as words in its text (`おすすめ:`, `→ 中止`, `それ以外`). Updated skills write the new form. A question still open at the update keeps its words but shows no choice buttons; answer it by writing.

### Highlights
- **`alpacawork uninstall`** removes the service, release files, installed skills and installation record, and keeps your data folder.
- **Setup can change an installation.** Run `alpacawork setup` again to approve a new port, public host (for phone access) or Node.js path. The port moves only while no Run is unfinished.
- **A file for the server's environment.** `~/.config/alpacawork/env` (`NAME=VALUE` lines, readable only by you) reaches the installed server after a restart, for agent keys and switches such as `DO_NOT_TRACK`.
- **Install through your AI.** The README gives one prompt, and your AI follows the setup guide in the alpacawork skill.
- **A fresh installation picks an AI you have installed** instead of Claude Code when only Codex is there.

### Setup
- Managed skills are linked into the folders Claude Code and Hermes read, also when Claude Code has no `~/.claude/skills` folder yet.
- The usage data page is rewritten for its readers and opens in the screen's language.

### Screens
- On a computer, a diff opens right of the task panel, which slides to the left. A file row shades whole when pressed, and side by side or stacked is chosen once for the whole diff.
- The task actions above the input explain themselves on hover.
- History no longer shows the "No agents running now" line.
- The "User instructions" field asks for the time with the date.

### Fixes
- Finishing or answering a review card opens the next task in the order the list shows now.
- After a reload, something you sent that the server already saved no longer shows "Cannot reach the server".

### Faster
- A task with a long History shows its rows at once instead of after about five seconds.
- A diff shows its text before its colours load, and diffs download compressed.
- Large histories and returns are read much faster.

## 0.1.0-beta.5

Usage data moves to version 2, the update confirmation says plainly what it does, and many screens were redrawn to read and behave alike.

**Update:** Settings → Update, or `npm install -g alpacawork@0.1.0-beta.5`

### Check before updating
- Agents that check the screen now open it with `?agent=1`. `?peek=1` no longer works: change skills or scripts that use it.
- Fields that come with the app can no longer be edited or deleted (`field set` / `field delete` refuse with `field_locked`); only whether they are required can be changed.
- A question whose choices start with the same word is refused; rename the later choice.

### Highlights
- **Usage data version 2.** A PC that chose to send usage data sends one report a day with a random install ID, and what it sent can be deleted. People who already agreed are asked again.
- **Clearer update confirmation.** It says what Update does, whether working agents keep going, and which skills it overwrites.
- **Why a Run failed is shown.** `run get` on a failed Run carries the agent's own error words, and processes a Run leaves behind are stopped when it ends.
- **Pages from this version explain themselves after the next update**: they say why the workspace cannot be shown and reload when they can, instead of an error that Retry could not fix.
- **Claude defaults to opus at medium effort** in new workspaces (fable is the other choice).

### Screens
- English screens read like English software (child tasks are now "subtasks"); Japanese screens call the AI エージェント.
- Status messages, tabs, menus and the model picker share one look; the model picker no longer jumps.
- On a computer, the conversation pane's controls moved to its head.
- Project fields light their whole row and open as one block.

### Fixes
- Checking the screen as an agent no longer silences your notifications.
- Pressing Up in the coordinator input no longer jumps over an empty line.
- The docked reader no longer shrinks while a finished task is read again.

### Faster
- Live updates do less work, and a pressed task shows its head at once with its History right after.

### License and security
- alpacawork is MIT licensed, and the package ships THIRD-PARTY-NOTICES.
- SECURITY.md says how to report a vulnerability.
