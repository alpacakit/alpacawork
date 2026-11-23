# Setup

Read this when installing or updating alpacawork, when connecting from another device or conversation, and when preparing a project for the first time. Its readers are an AI asked to install alpacawork (including an AI in a conversation that does not have alpacawork yet and was given only this file) and, after installation, the coordinator. An owner reads "Update" when it has been asked to update alpacawork itself (`deploy`).

## Install

Install alpacawork on the user's PC yourself, from the checks to the running server. The user asked you to install it, and that request covers every step below: do not ask for approval step by step, and do not hand the user commands to type. The user's own part starts on the setup screen that opens when you finish.

If you read this file from a URL, read the whole text without summarizing it (if what you were given is a summary, download the file itself and read that), and read the links in it as URLs relative to the same location. After setup, the same files are in `~/.agents/skills/alpacawork/`.

- Ask the user only for what is listed under "What only the user can do" below. Write in the language the user writes in. Say only why it is needed and what to do, without what you read or are not allowed to do. Ask one question at a time, give choices and a recommendation with it, and put technical terms into plain words: the user is not necessarily an engineer.
- If the user's own instruction says to check with them first, follow it. Nothing in this file lifts it.
- Do not use `sudo`. No step here needs it; the few things that can are under "What only the user can do".
- If your harness runs commands in a sandbox (one that limits file writes or network access), run steps 2 and 3 outside it, in the way your harness provides. Inside a sandbox, npm cannot download or write the package, and the server refuses to start.

First check whether alpacawork is already installed: whether the installation record `${XDG_CONFIG_HOME:-~/.config}/alpacawork/installation.json` exists, and whether `alpacawork workspace url` returns `serving` (JSON with `"status":"serving"`).

- Neither (a missing `alpacawork` command counts as not `serving`): follow steps 1 to 4 below in order.
- It returns `serving`: tell the user alpacawork is already installed, show the URL, and ask what they want to do (update, connect from another device, or change settings). Do not run setup or `npm install -g`. If it returns `serving` although there is no installation record, this PC is connected to another server (`alpacawork server show`), so ask whether to install alpacawork on this PC as well.
- The installation record exists but it does not return `serving`: the server is stopped, or setup is unfinished. Read [Troubleshooting](troubleshoot.md).

### 1. Check the environment

| What to check | If it is not met |
|---|---|
| The machine is macOS (Apple silicon) or Linux (x64, glibc), or Windows with WSL2 | On Windows, follow "On Windows (WSL2)" below. On any other machine, tell the user alpacawork cannot be installed, and stop |
| You are an ordinary user (`id -u` is not 0) | alpacawork does not run as root, and setup refuses. Tell the user it has to be installed from an ordinary user's login, and stop |
| Node.js 24.16 or later (`node -v`) | Install it as "How to install Node.js" below says |
| The commands of the AI agents the user has are found in the shell where you will run setup (`command -v claude codex grok pi`) | setup looks for them on that shell's `PATH`, and the auto-started server keeps that `PATH`. If you know of one that is installed somewhere this shell does not look, add its folder to `PATH` in the setup command; otherwise go on without asking. The setup screen lists every supported agent with its state: signed in; not signed in (with the command to sign in); installed, where alpacawork cannot check the sign-in (always so for Grok Build and pi, which work once signed in or given an API key); or not found |

The supported agents are Claude Code (`claude`), Codex (`codex`), GitHub Copilot (bundled with alpacawork; it runs on the GitHub CLI sign-in, `gh auth login`), Grok Build (`grok`) and pi (`pi`). The user needs at least one that is installed and signed in before handing over a task, but none is needed to install alpacawork.

How to install Node.js:

- Choose a way of installing that lets `npm install -g` succeed without `sudo`. Installing a single 24.x version with a version manager (such as nvm, fnm or mise) is a good fit.
- If the user already uses another version of Node.js, leave it and their default version as they are, and install 24 alongside it without asking. Run steps 2 and 3 with 24.16 or later selected (for example `nvm exec 24 npm install -g alpacawork`). The server then runs on that Node.js whatever the default is. The `alpacawork` command runs on the `node` of the shell it is run in, so it is found only where that version is selected: say so in step 4.
- A version manager puts `node` on `PATH` from the shell's startup file, so right after installing it your shell may still fail to find `node`, `npm` and, later, `alpacawork`. Before deciding that the installation failed, load the version manager in the same command (or start a new login shell), and run the following steps where `node -v` answers.
- setup records the real path of the Node.js it was run with (`realpath "$(command -v node)"`), and auto-start launches the server with that path too. If the real path changes, for example through a version update, auto-start cannot start the server and deploy is refused. When that happens, run setup again as described under "Change the installation" below. Homebrew's `node` changes its real path on every update, so setup has to be run again each time.

#### On Windows (WSL2)

alpacawork, Node.js and the agents' AI commands all go inside the Linux distribution of WSL2 (Ubuntu below), and so does the conversation that follows this procedure. Every command is run in Ubuntu unless PowerShell is named.

- If this conversation runs on Windows itself, WSL2 has to be prepared first, and that part is the user's: the user runs `wsl --install` in a PowerShell opened as administrator, restarts Windows if asked, and creates a Linux user name and password when Ubuntu first opens (<https://learn.microsoft.com/windows/wsl/install>). The user then opens Ubuntu (type "Ubuntu" in the Start menu), installs and signs in to an AI command there, starts it, and gives it the same instruction they gave you. The rest of this procedure continues in that conversation.
- `ps -p 1 -o comm=` prints `systemd` when systemd is on, which setup requires. An Ubuntu installed with `wsl --install` has it on. If it is off, the user adds the two lines `[boot]` and `systemd=true` to `/etc/wsl.conf` (needs `sudo`), runs `wsl --shutdown` in PowerShell, and opens Ubuntu again (<https://learn.microsoft.com/windows/wsl/systemd>).
- WSL2 adds the Windows `PATH` to the Linux one, so a command can be found on the Windows side instead. `command -v node npm`, and the same for each AI command, must print paths that do not start with `/mnt/`. Install inside Ubuntu whatever is found only under `/mnt/`.
- The data folder must be on the Linux side, as the default `~/alpacawork` is. setup refuses a folder on a Windows drive (under `/mnt/`).
- For use from a phone ("Connect" below), Tailscale goes on Windows, not inside Ubuntu, and the `tailscale serve` command is run in PowerShell.
- The user opens the screen in a browser on Windows, with the URL setup prints.
- alpacawork runs only while Ubuntu is running. WSL starts Ubuntu when something opens it, not when the user signs in to Windows, and it can stop Ubuntu, with the server and everything else running in it, once nothing on Windows has it open, for example after the last Ubuntu terminal is closed. A systemd service does not keep WSL running (<https://learn.microsoft.com/windows/wsl/systemd>). In step 4, tell the user to keep one Ubuntu window open while they use alpacawork, also while they use it from a phone, and to open Ubuntu again after Windows restarts or after `wsl --shutdown`: the server then starts by itself with the tasks as they were, and setup is not run again.

### 2. Install with npm

Run `npm install -g alpacawork` (without `sudo`). If it fails because npm's global folder is not writable, Node.js was installed system-wide: install Node.js as "How to install Node.js" above says, then run it again.

### 3. Run setup

Run `alpacawork setup --yes --lang <tag>` yourself.

- `--yes` (or `-y`) goes ahead without the confirmation in the terminal; where there is no terminal, setup stops without it. What the user decides (the agents to use, whether to send usage data, the skills, the first project) is asked on the setup screen, so do not ask about it here.
- `--lang` takes the language the user writes in as a BCP 47 tag (for example `--lang ja`): a new installation uses it for the screen and for the AI's replies, so do not ask which language.
- setup creates the data folder (`~/alpacawork`; it cannot be changed after installation), registers auto-start at login on a free port it picks, and installs the alpacawork skill to `~/.agents/skills` (linked from `~/.claude/skills` when Claude Code is present). Add `--workspace <folder>` only when the user named another data folder or existing data to use. If setup refuses because `~/alpacawork` is not empty, nothing was changed: ask the user which folder to use.
- setup refuses, changing nothing, under `sudo`, as root, and from an agent that alpacawork itself started.
- When setup finishes, it prints `✔ Installed alpacawork <version>` and the screen's URL on an "Open:" line. If the running server's agent check answers, setup lists the agents ready to use and the sign-in commands the check reports, as on the setup screen. If the check cannot be read in time, check the agents on the setup screen. On macOS and Linux it also tries to open the screen in the browser and says so when it did ("Opened in your browser."); over SSH or with `--no-open`, it does not try, and the attempt can fail, for example on WSL2. These lines are printed in the language of `--lang`, or of the terminal's locale without it, when alpacawork has that language, and in English otherwise.
- If setup stops partway, fix the cause it shows and run the same command again, with the same arguments (it continues from the saved request). Do not delete the installation record or the data and start over. If that does not fix it, read [Troubleshooting](troubleshoot.md).
- On Linux, auto-start runs only while the user is logged in (it is a systemd per-user service). When the user wants alpacawork to keep running on a machine that nobody stays logged in to (for example, one left with its screen closed), run `loginctl enable-linger`. On WSL2 this does not replace keeping Ubuntu open ("On Windows (WSL2)" above): whether it keeps WSL running has not been confirmed.

### 4. Hand over to the user

Check that `alpacawork workspace url` returns `serving`, then tell the user the following in one short message, as information and not as questions.

- The URL of the screen, and that it is already open in their browser when setup said so. The setup screen takes them through four steps (the screen's language and theme, the agents and usage data, the skills, the first project) and explains each one, so do not explain or ask about them in the conversation.
- The URL stays the same after the browser is closed or the PC restarts: they can bookmark it, or install it as an app from Chrome or Edge, and `alpacawork workspace url` shows it again.
- For each agent that setup reported as not signed in: the sign-in command it printed. The setup screen shows the same command, and "Check again" picks up the sign-in.
- alpacawork can be used from a phone through a VPN, and you set that up when they ask ("Connect" below).
- If you installed Node.js 24 alongside another version: the `alpacawork` command is found only in a shell where 24 is selected. The screen works either way.
- Whatever applies to this PC under "What only the user can do" below.

From here on, act as the coordinator. Read `~/.agents/skills/alpacawork/SKILL.md`. The setup screen decides the first project's folder, policy and skills; use "What to ask first" below when the user asks you to create another project.

### What only the user can do

Everything else in this file is yours to do. Give the user one of these only when it applies, with the exact command or place and the reason, and go on with whatever does not depend on it.

| What | When |
|---|---|
| Choose on the setup screen: the agents to use, whether to send usage data, the skills, the first project | The first time the screen opens |
| Say what they want done (update, connect from another device, change settings, or install on this PC as well) | alpacawork is already installed, or this PC is connected to another server (the check before step 1) |
| Choose the data folder | setup refuses because `~/alpacawork` already holds something else (step 3) |
| Sign in to an AI agent with its own CLI (for example `claude auth login` or `codex login`), or install one | The setup screen shows the agent as not signed in or not found, or the agent is one whose sign-in alpacawork cannot check (Grok Build and pi). For an AI used with an API key, the user writes the key into the server's environment file (["Environment variables" in Configuration](config.md#environment-variables); shell environment variables do not reach the auto-started server). Do not ask for a key in the conversation |
| Allow what your harness asks permission for | Your harness stops to ask before it runs a command or leaves its sandbox |
| Anything that needs `sudo` or an administrator | On Windows: `wsl --install`, and turning on systemd in WSL. On Linux: a `tailscale` command that asks for it, and `loginctl enable-linger` when it asks for authentication |
| Install a VPN app (for example Tailscale) on the PC and on the phone, and log in to both with the same account | The user wants to use alpacawork from a phone or another device |
| On the phone: open the screen, add it to the home screen, and turn on notifications | The same. The screen shows the steps under "Settings → App & phone" |

## Change the installation

- What can be changed after installation is the port, the name used to open the screen from other devices (`--public-host`), and the real path of Node.js. When the user asks for such a change, or the real path of Node.js has changed, run `alpacawork setup --yes` (adding `--port` and/or `--public-host` if there is a value to change; a value that is not given stays as it is). It prints each thing that changes in its own row ("Port", "Public host", "Node.js", "PATH"; in Japanese with `--lang ja`) as "old value → new value", rewrites the installation record and the auto-start definition, and restarts the server. At the same time, the auto-start `PATH` is replaced with that of the shell where setup was run.
- A difference in `PATH` alone is not treated as a change.
- A port change is refused while any Run is unfinished (a running agent reports to the port it was launched with). While an update or a setup is unfinished, every change is refused, so finish that first as the message says.
- The data folder cannot be changed, and the name for opening from other devices cannot be removed.

## Uninstall

- Uninstall only when the user has asked for it. Run `alpacawork uninstall --yes`, then `npm uninstall -g alpacawork`. The first command prints what it removes and what it keeps. The data folder is not removed, so tell the user where it is. Uninstall is refused while a Run is running, and from an agent that alpacawork itself started. The detailed rules for what is removed are in `alpacawork uninstall -h`.

## Update

- Updating is an action with outside effects, so check the scope of approval before running it (["Approval defaults" in the main skill](../SKILL.md#approval-defaults)).
- There are two ways to update: the user presses "Update" in the screen's settings, or `alpacawork deploy npm:alpacawork` installs the latest version from npm (`npm:alpacawork@<version>` for an exact one).
- When deploy is run from an execution environment that has no terminal, it changes nothing and returns the plan and a confirmation value. Read the plan (the destination, and the current version → the version to be installed), then run the same command with the confirmation value added.
- On a machine that already has an installation, running `alpacawork setup` with no value to change acts as a switch to the version installed with npm (if the npm version is the older one, it goes back to the older version). Do not use it to update.
- An update overwrites installed skills that are still bundled (alpacawork and alpacawork-betterquality) with those of the new version. Existing private add-ons are kept unchanged. Edits made by hand are lost, so write the user's preferences in the project policy instead of rewriting the skills.
- A version that changes the database or the contract with Runs refuses to switch while any Run is unfinished. Do not cut running Runs short to get the update through; run the update again after they have ended on their own and their results have been taken in (to pause agents for an update, see ["Stopping for maintenance" in Coordinator](coordinator.md#stopping-for-maintenance)). Any other version switches without stopping the Runs that are running.
- During the switch, the screen and writes are stopped. When it is over, tell the user to reload the screens they have open (if the version shown does not change after reloading, have them close every open screen and open it again).
- If an update stops partway, or to go back to the previous version, read ["An update stopped partway"](troubleshoot.md#an-update-stopped-partway).

## Sync the skills

- setup installs only the alpacawork skill. `alpacawork skills update` reinstalls the bundled skills (alpacawork and alpacawork-betterquality) into `~/.agents/skills` at the current version, without asking for confirmation. Check update approval before running it. Agents follow [Open the skills for your next action](../SKILL.md#open-the-skills-for-your-next-action). Existing alpacawork-majority and alpacawork-try-and-keep installations are kept, but are no longer updated from this distribution.
- Most agents read `~/.agents/skills` themselves. Claude Code reads only the skills in `~/.claude/skills`. On a machine that has Claude Code (the `claude` command is found, or `~/.claude` exists), setup and `alpacawork skills update` create links in that folder to the skills they placed. If something with the same name is already there, they report it instead of creating the link (that content keeps being read, so ask the user, then move it out of the way and run the command again). For skills that are not bundled, add a link of the same form (from `~/.claude/skills/<name>` to `~/.agents/skills/<name>`).
- Agents run on the server machine, so install the skills that agents are to use on the server machine. To make requests from a conversation on another PC, install the alpacawork command and skill on that PC too (that PC also has to meet the same OS and Node.js requirements).
- If a command reports `CLI contract mismatch`, run the repair command in that error on the PC running the CLI, after checking update approval. It installs the server's version of both the CLI and the bundled skills; reread the skills before sending again. Do not run setup for this repair. If the refusal continues, follow [Troubleshooting](troubleshoot.md#a-task-does-not-move).

## Connect

- Check which server the CLI sends to, and where that selection came from, with `alpacawork server show` (the selection order is in `alpacawork server -h`). To use alpacawork from another PC, save the server with `alpacawork server set <URL>` (the URL is the entry point's `https://…`; it is not saved if the server cannot be reached). Agents launched by alpacawork need no setting, because the server passes them its own address.
- An operation run from an outside Claude Code or Codex conversation is treated as the coordinator's. An operation run from a terminal that is neither is treated as a person's.
- When you make a request from a conversation on another PC, `--cwd` and the code location are read as paths on the server machine, and agents cannot read the files on your PC. Pass what they need in the body of the request text.
- The server listens only inside its own machine (`127.0.0.1`). Opening the screen from a browser on a phone or another device takes the following three things.
  - A route from the device to the server machine (a VPN; for example Tailscale)
  - An entry point that accepts HTTPS and passes it to the port on `127.0.0.1` without changing `Host` (for example `tailscale serve`)
  - `--public-host`, which tells the server the name of that entry point (a lowercase `name[:port]`, the same as the `Host` the browser sends)
- Over plain HTTP to the PC's IP address or to the `--public-host` name, the screen does not open from another device. The server refuses a `Host` that is neither its own loopback address nor the `--public-host` name (403), and under that name it accepts only `https://<name>` as the origin, so an `http://` page stays blank.
- Set this up when the user asks to use alpacawork from a phone or another device. An example with Tailscale:
  1. The user installs Tailscale on the PC and on the phone and logs in to both with the same account ("What only the user can do" above). Give the user the command for their PC, or the installer from <https://tailscale.com/download>.
     - macOS: `brew install --cask tailscale-app` (not `brew install tailscale`, which is a different, command-line-only build).
     - Windows: `winget install --id Tailscale.Tailscale` in PowerShell. The user logs in from the Tailscale icon in the system tray.
     - Linux: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up` and open the URL it prints.
     - Phone: the Tailscale app from the App Store or Google Play.
  2. Create the HTTPS entry point on the PC: `tailscale serve --bg --https=443 http://127.0.0.1:<port>`, with the port from `alpacawork workspace url`. On macOS the `tailscale` command may not be on PATH (use `/Applications/Tailscale.app/Contents/MacOS/Tailscale` inside the app). On Linux it may need `sudo`; then the user runs it. If HTTPS is not set up yet, Tailscale prints a URL with instructions; have the user open it.
  3. Take the URL that is shown, remove `https://` and the trailing `/`, and pass the remaining name (for example `pc-name.tailnet-name.ts.net`) to setup: `alpacawork setup --yes --public-host <name>` ("Change the installation" above).
- The steps for the phone are shown under "Settings → App & phone" on the screen (with a QR code too, once the entry point's URL is set). Point the user there. The current URL can be read with `alpacawork workspace url`. Adding the screen to the home screen and registering for notifications ("Settings → Notifications") are done by the user on that device. A phone can register for notifications only when the screen was opened through the HTTPS entry point, and on an iPhone it has to be opened from the icon added to the home screen.
- None of the three is authentication. The screen and the API have no login, and anyone who can reach the entry point can do everything the user can. Keep the entry point within reach of the user's own devices only, and do not configure anything that exposes it to the internet (such as Tailscale Funnel or opening a port).

### Connect an MCP client

On the server, run `alpacawork setup --mcp on` and read the permissions in the confirmation. For another device, use the Tailscale Serve address from the steps above. If setup cannot read the Tailscale configuration, check on the host that the alpacawork port is private before adding `--confirm-private-tailnet`. To disable the endpoint, run `alpacawork setup --mcp off`.

- In a client with Streamable HTTP, such as Cursor, register `https://<your-tailnet-host>/mcp`. For example, in the client's `mcpServers` object add `"alpacawork": { "url": "https://<your-tailnet-host>/mcp" }`.
- With stdio, such as Claude Desktop, add `"alpacawork": { "command": "/absolute/path/to/alpacawork", "args": ["--server", "https://<your-tailnet-host>", "mcp"] }` to `mcpServers`. On the alpacawork PC you can omit the server option to use the CLI's existing server selection.
- When the client lets you set approvals per tool, require approval for `alpacawork_write`. It can accept results, answer as you, launch AIs, change their future launch settings and run a program to inspect it.

Keep coordinator registrations scoped to the clients you use for that role. Avoid a global Claude Code or Codex registration that alpacawork's launched agents also load. If you register MCP for an alpacawork Run, use `alpacawork mcp --run` and pass `ALPACAWORK_RUN` and `ALPACAWORK_RUN_TOKEN` from that Run's environment. A coordinator registration that receives neither value uses coordinator permissions.

## What to ask first

When creating a new project at the user's request, ask only about what is not yet decided, one item at a time, and write each answer where the table below says. First ask which folder to work in, then ask the rest in a way that also lets the user choose "decide later" or "leave it to you". For anything the user leaves to you, go on with the default. Do not ask for the project's summary; write it yourself from the answers (["Turning a request into a task" in Coordinator](coordinator.md#turning-a-request-into-a-task)).

| What to ask | Where to save it |
|---|---|
| Which folder to work in | A project and its code location (`task new --kind project`, `task update --cwd`) |
| What may go ahead without asking, and what has to be asked first (the scope of delegation, and the scope of approval) | Project policy |
| How to take results in (for example: build on a branch and merge it into main after the user accepts it, or open a PR) | Project policy |
| Which skills to use for each purpose (table below) | Install the skills the user chooses and record project-specific instructions in the project policy |
| Preferences for the AI and model used for agents | Project policy (the selectable values are in [Configuration](config.md#agents-agents)) |
| The reply language (only when the user's own writing does not settle it) | The personal setting `ai.language` (["Language for the user" in Coordinator](coordinator.md#language-for-the-user)) |

The setup screen offers the skills below. Project policy starts empty. The agent can use installed skills for the relevant work, and the user can name a different choice for a particular purpose in project policy. Install the bundled skills as described under "Sync the skills" above. alpacawork does not manage skills that are not bundled, so get the user's approval and install each one by the method of its distributor (for those in `alpacakit/pocket-skills`, `npx skills add alpacakit/pocket-skills --skill <name> -g`).

| Skill | Purpose | What it is for |
|---|---|---|
| askmeclearly (recommended) | reports and questions | Agents keep questions and reports short and mark where to look in images or video, so the user can decide and check quickly |
| doyourjob (recommended) | decision triage | Agents look up what they can and decide what they may, so they ask the user only what the user alone can decide |
| alpacawork-betterquality (recommended; bundled) | planning and review | Agents set the pass criteria before work starts, and another AI checks the result before the user is asked to review it. Results get better, but the checks add time and token usage. The number of checks depends on how heavy the work is; for light work, the agent checks its own result |

### Private add-ons

alpacawork-majority and alpacawork-try-and-keep are maintained in the private repository `alpacakit/pocket-skills-private`; they are not bundled. Access to that repository is required for new installations and updates. With the user's approval, install them separately using `npx skills add alpacakit/pocket-skills-private -s <name> -g`. Majority requires alpacawork; try-and-keep also requires alpacawork-betterquality. Betterquality needs neither private add-on.

Keep existing installations and project policy selections when moving the source. If the policy still selects try-and-keep, it continues to apply; provide the private skill on any new agent machine before using that policy. Removing the selection is a separate decision for the user. Do not delete or edit an existing alpacawork installation receipt to change the source of an add-on; review any replacement separately.
