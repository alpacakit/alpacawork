# Configuration

The coordinator reads this when asked to read or change settings, when adding or changing the AIs or models in use, and when an agent does not start because of a setting. Read the current values with `config get`, `settings get` and `task get`.

## What lives where

| What you want to change | Where it lives | How to change it |
|---|---|---|
| The AI that starts task requests, and what takes over | `aiStack` in `config.yaml` | `config set --config` with `limits` and `aiStack` together, or "Settings → AI → AI for tasks" on the screen |
| The AI that answers messages from the input, and what takes over | `coordinatorAiStack` in `config.yaml` | `config set --config` with `limits` and `coordinatorAiStack` together, or "Settings → AI → AI you talk to in the input (coordinator)" on the screen |
| The number of Runs running at once, time limits, the attachment limit | `limits` in the server's `config.yaml` | `config set`, or "Settings → General → Advanced options" on the screen |
| The AIs in use, the models and other values selectable in a request, launch options | `agents` in `config.yaml` | `config set --agents` with the full agents block, or "Settings → AI → Settings for each agent" on the screen |
| The folder agents work in | The project's code location | `task update --task <P number> --cwd`, or the project's settings on the screen |
| A project's summary (what the project is for, in one sentence) | The project | `task update --task <P number> --values-file` with `project_summary`, or the project's settings on the screen (["Turning a request into a task" in Coordinator](coordinator.md#turning-a-request-into-a-task)) |
| The project policy, the fields tasks write | The project | For the project policy, ["Authority" in Coordinator](coordinator.md#authority); for the fields the project uses, `field use`; for field definitions, `field set` |
| The screen's language, theme and notifications; the reply language | Personal settings | `settings set`, or "Settings → General" (language, theme) and "Settings → Notifications" on the screen |
| The port, the name for opening the screen from other devices | Decided at installation | [Setup](setup.md#install) |
| API keys, `PATH`, proxy | The environment the server was started with | "Environment variables" below |

- `config.yaml` is directly under the data folder. Saving it needs no restart. Editing it by hand lets you write broken content too, which is refused when it is read. A single unknown key or old form makes the whole file count as unreadable (symptoms and fixes are in [Troubleshooting](troubleshoot.md#configyaml-cannot-be-read)).
- Pass `config set` every item of `limits` and the full text of `agents` (it does not accept a partial value). First read the current values, `agentsText` and `hash` with `config get`. If the configuration was changed from somewhere else after you read it, `config set` is refused; read again and make the change again.
- There is one set of personal settings per server, and it does not distinguish between people. Every device that connects to the same server has the same values.

## AI stacks

```yaml
aiStack:
  - { agent: claude, values: { model: opus, effort: medium } }
  - { agent: codex, values: {} }
coordinatorAiStack:
  - { agent: claude, values: { model: opus, effort: low } }
  - { agent: codex, values: {} }
```

Each stack lists named, enabled agents and their launch values in order. The first row is the default. The next row takes over on a usage limit or capacity stop. If the last row stops, the request ends.

When `coordinatorAiStack` is missing, the coordinator uses one default row from the first agent in `aiStack`, or the first enabled agent in configuration order if the task stack has no rows. The row uses the agent's starting values, with `low` effort when its starting model uses effort and offers `low`. With an explicit `coordinatorAiStack: []` or no enabled agents, the coordinator has no AI to launch.

Coordinator stack changes apply when the next message is accepted. The coordinator checks the rows in order, skips duplicate launches, and skips rows whose latest run in this conversation hit a usage or capacity limit. If every row hit a limit, it checks again from the top. Only rows below the chosen row can take over.

`config get` returns each saved stack with the values its rows use. The server derives the coordinator's default row when choosing a launch, so the row stays out of `config.yaml` and `config get`. Include either stack in the YAML passed to `config set --config` along with the full limits. Omitting a stack from the edit leaves it as saved. Use `[]` to clear it.

## Run limits (limits)

| Key | Default | Meaning |
|---|---|---|
| `parallel` | 8 | The number of owner and member Runs that run at the same time. It is shared by all projects, and Runs beyond it wait in a queue. The screen's coordinator is not counted. A Run left in `needs_review` also occupies a slot (except `conversation_busy`) |
| `run_minutes` | 0 (no limit) | The time limit for one Run of an agent. A Run that exceeds it is stopped and marked as failed (`timeout`) |
| `depth` | 8 | The number of levels requests can go down from parent to child. Beyond it, a request is refused with `too_deep` |
| `children_per_run` | 200 | The number of requests to children that one Run can make (finished children count too). Beyond it, a request is refused with `too_many_children` |
| `automatic_per_placement` | 20 | The maximum number of times a request is delivered automatically to the same agent without a person's request (for what happens when it is reached, see [Waking](lifecycle.md#waking)). 0 stops all automatic requests |
| `attachment_mib` | 50 | The maximum size of a single attachment or task file (1 to 500). When it is lowered, even reading an existing file larger than it is refused |
| `coordinator_run_minutes` | 30 | The time limit for one execution of the screen's coordinator |
| `coordinator_command_seconds` | 10 | The time limit for one command that the screen's coordinator runs (["Principles of the role" in Coordinator](coordinator.md#principles-of-the-role)) |

- A change takes effect from the next request accepted and the next launch. A Run that is running continues with the values it was launched with, and lowering `parallel` does not stop it.
- The last two keys in the table apply only to the screen's coordinator, not to outside conversations or to agents.

## Agents (agents)

`config get` returns the saved YAML in `agentsText`, the effective settings in `agents`, and each adapter's defaults in `catalog`. See `config get -h` for the shape of `agents`.

- Only the adapters alpacawork supports can be used (they are listed in `catalog`). The user installs each CLI and signs in on the server machine, in that CLI's own way. Supported IDs are `claude`, `codex`, `copilot`, `grok` and `pi`.
- A setting written in `config.yaml` keeps its value on update. Omit a `params` key, `env`, `without`, or `options` to use this version's default for it. For example, `codex: {}` follows all Codex defaults. An alias follows the defaults of its `adapter`. Write `[]` to leave a candidate list or the additional environment list empty, and `without: {}` to clear model-specific omissions. Saving in Settings omits values equal to the current defaults on save. `config set` preserves the agents block as supplied.
- Before updating, remove profiles whose kind is no longer supported from `config.yaml`. Reads identify an unavailable kind and its YAML line until it is removed. Existing Run history stays readable.
- With `enabled: false`, a profile accepts no new requests, but agents whose requests were already accepted are not stopped. A new workspace lists only the adapters whose model-free sign-in check confirms readiness, all enabled. The setup screen checks again, switches on the adapters signed in by then, and when its agents step is left with Next or "Continue without an agent", lists every supported adapter, on or off as chosen there. The first enabled profile in configuration order is the default. "Set as default" in "Settings → AI" saves that order; existing settings are never reordered by command detection.
- A row added to `params` has no effect on the launch, and does not appear as a selection field, unless the launch options use it as `{key}`. To use a key that the default launch options do not have, edit `options`.
- `options` (edited launch options) is not guaranteed to work. Breaking the arguments that concern the output format, the result file or the continuation of a conversation makes agents fail or unable to continue their conversations. When editing, start from the default `start` and `resume` in `catalog`, and copy that adapter's `optionsBase` into `base`. Deleting `options` goes back to the defaults.
- Launch options do not go through a shell. They are split into arguments at whitespace, and whitespace inside `'…'` or `"…"` does not split. `[ … ]` is a group that can be left out: if a `{key}` inside it has no value, the whole group is dropped. alpacawork fills in `{session}` (the conversation ID) and `{result}` (the file the agent is made to write its reply to). Where they can be used depends on the adapter (claude: `{session}` only; the others: `{result}` in a new conversation, and `{result}` and `{session}` in a continued one), and writing one where it cannot be used is refused on save. Literal braces cannot be written, so make a JSON-like value a value in `params` and pass it with `{key}` (a value cannot contain a comma).
- There is no field for choosing permissions. Every adapter is launched with settings that run without asking for confirmation (because agents run unattended). Agents run with the permissions of the user who started the server, and narrowing them with launch options adds no OS isolation.
- Do not write secrets in launch options or in `--url` (they stay as written on the settings screen, in `config get` and in Run records). Put secrets in environment variables, as described under "Environment variables" below.

## Executable location and sign-in status

- Each profile can set `command: /absolute/path/to/executable`. Omit it to resolve the adapter's command on the server PATH. Relative paths, arguments and `command` on bundled runtimes (including Copilot) are refused. Paths containing spaces are single literal paths; do not add shell quotes. Keep this out of `options`.
- Request admission resolves and validates the executable, then freezes the location in that Run's launch arguments. Changing configuration or PATH does not change accepted Runs. A missing or non-executable explicit path is refused without falling back to another command.
- `alpacawork config get` reads settings without running executables. Add `--check` for fresh `availability` keyed by profile and `detected` keyed by adapter. Each entry has `command` (null for bundled/missing), `version` (null when unavailable), `candidates` (`path` and `version` for each executable on the server PATH), `status`, `nextAction`, and `issue` (null or the executable error).
- `status` is `ready`, `signed_out`, `unknown`, or `not_found`. Checks share one 10-second deadline and reuse each executable result, and never call a model. Readiness does not verify subscription or model access. These observations are never saved and never rewrite existing settings.
- On the screen, "Settings → AI" shows the same observations: a closed agent shows one line only when it is signed out or its executable is missing, and an opened agent's "Executable" row writes `command` ("Automatic" removes it). A user can fix these there instead of asking you.
- Inspect a typed path with `alpacawork config inspect --adapter codex --command /absolute/path/to/codex`. Its version-only result is in `inspected`; it does not sign in or start a conversation. `catalog[].command` is the executable name or null for bundled runtimes. An observation's `nextAction` describes sign-in, or is null when no sign-in check exists.
- Candidates come only from the server PATH, without searching version-manager folders. A Node CLI using `#!/usr/bin/env node` runs the first Node on that PATH even when its own path names another Node installation. To change the service PATH, follow [Change the installation](setup.md#change-the-installation).

## Environment variables

- `env` lists the additional environment variable names for a profile. When omitted, it follows the adapter's default list shown in `catalog`. Write `env: []` to pass no additional variables. Values come from the environment the server was started with and are never saved in `config.yaml` or Run records. Names in the basic environment, names fixed for each adapter, names beginning with `ALPACAWORK_` and some others cannot be written in `env`.
- Agent launches receive the basic environment (`PATH`, `HOME`, language, proxy and the like), each adapter's fixed names for its conversations (such as `CODEX_HOME` and `CLAUDE_CONFIG_DIR`), and the profile's effective `env` names.
- The environment of the auto-start that setup registered is fixed: `HOME`, the `PATH` of the terminal where setup was approved, and a few others. Environment variables written in shell configuration are not included. Do not rewrite the auto-start definition by hand (setup and deploy then refuse because it differs from the record). Agents' executables are looked up on this `PATH`. For how to replace `PATH`, see ["Change the installation" in Setup](setup.md#change-the-installation).
- To give the server API keys and the like, write `name=value`, one per line, in the environment file on the server machine (`${XDG_CONFIG_HOME:-~/.config}/alpacawork/env`). These are secrets, so the user writes them. Make it a regular file that only the user can read and write (`chmod 600`; otherwise none of it is read). `HOME`, `PATH`, names beginning with `XDG_`, names beginning with `ALPACAWORK_` (except `ALPACAWORK_TELEMETRY_DISABLED`) and some others cannot be set from this file.
- The server reads this file once, when it starts. After writing to it, restart the server. The result of the read (how many variables were set, why the file was not read, and the numbers of the skipped lines) appears at the foot of "Settings → General" on the screen, and a problem with the file also at the top of "Settings → AI". Values and names appear neither on the screen nor in records.
- The environment of a running Run does not change.

## Code location

- `--cwd` in `task request -h` describes how the directory an agent launches in is decided.
- The value is an absolute path on the server machine, and a path inside the data folder cannot be given. If it points to a folder that was deleted later, a request for a new conversation is refused.
- `--cwd ''` cuts the inheritance from the parent and launches the agent in the data folder. To go back to inheriting, clear the field in the project's settings on the screen.
- A change takes effect from the next new conversation.
