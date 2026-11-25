# Troubleshooting

The coordinator reads this when the user asks why a task is not moving, or says that the server does not start, that an update stopped partway, or that they want to restore data. The rules for task and Run states (failure, hold, stop) are in [Delivery and completion](lifecycle.md); this file covers how to find the cause and the recovery that is done on the server machine.

The user runs the recovery on the server machine, typing it in their own terminal: stopping and starting the server, `workspace maintenance`, the `release` commands, moving the installation record aside, starting the server by hand, and setup. The coordinator checks the state with read-only commands and tells the user which procedure applies, what to type, and what will be lost by it.

Recovery actions can lose data. Read the error text and guide the user only through a procedure below that it matches. When none matches, do not propose deleting or rewriting records or data; tell the user what you found and stop.

The `alpacawork-backend` typed on the server machine belongs to the version installed with npm, which can differ from the running version (`current` in the releases folder). Run maintenance and recovery commands with the running version's `<releases folder>/current/bin/backend.mjs` (during a switch, the one under the `target` in `switch.json`). The default releases folder is `~/.local/share/alpacawork/releases`.

## Check first

| What you want to know | What to read |
|---|---|
| Whether the server is running, and the screen's URL | `alpacawork workspace url` (returns a URL only when `serving`; if the server cannot be reached, it fails with a connection error) |
| Which server the CLI sends to | `alpacawork server show` |
| The state a Run ended in, and the reason | The Run's `state` and `reason` in `alpacawork task get --task <ID> --runs <count>` |
| A Run's reply, and the agent's error text | `alpacawork run get --run <ID>` |
| Returns that arrived, and requests not yet handled | `alpacawork task returns --task <ID>`, `alpacawork task get --task <ID> --include openObligations` |
| The server's output | On Linux, `journalctl --user -u alpacawork.service`. On macOS there is no output file; `launchctl print gui/$(id -u)/alpacawork.service` shows only the status |
| How an update has progressed | `switch.json` and `.updates/controller.log` in the releases folder |

To stop and start the server that setup registered, use `alpacawork stop` and `alpacawork start`, or `systemctl --user stop alpacawork.service` and `systemctl --user start alpacawork.service` on Linux, or `launchctl bootout gui/$(id -u)/alpacawork.service` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/alpacawork.service.plist` on macOS. Do not find the process by name and kill it.

On WSL2, the server runs only while Ubuntu is running, and Windows does not start Ubuntu when the user signs in (the last item of ["On Windows (WSL2)" in Setup](setup.md#on-windows-wsl2)). When the screen does not open, the user runs `wsl --list --running` in PowerShell before opening Ubuntu; it lists Ubuntu only while Ubuntu is running. If Ubuntu is not listed, the user opens it, keeps that window open, and opens the screen again. If the screen then opens, setup is not run again; tell the user to keep one Ubuntu window open while they use alpacawork, and check the tasks that were being worked on ("A task does not move" below). If Ubuntu was listed, or the screen still does not open, look for the cause in the rest of this file. If nobody looked before Ubuntu was opened again (starting a conversation inside Ubuntu opens it), the cause of the earlier failure is undetermined, even when the server answers now. Say so, and have the user run the PowerShell check first if it happens again.

## A task does not move

- `CLI contract mismatch` means the CLI's requests were refused before processing. On the PC running the CLI, check update approval and run the error's repair command to install both the CLI and skills at the server's version, then reread the skills and send again ([Sync the skills](setup.md#sync-the-skills)). If the refusal continues because that PC also has a server installed, its CLI uses that installation's current release: run `alpacawork deploy npm:alpacawork@<version>` on that PC, replacing `<version>` with the server version shown in the error and following the update approval procedure.
- A task is not woken automatically when it is done, on hold or failed, when it has a Run in `needs_review`, or while it is being worked on. When a result should have arrived but the task does not move, read `disposition` in `task returns`. A return stays `pending` for one of these reasons: hold, failure, the automatic limit (`limits.automatic_per_placement`), no definition of that AI in `config.yaml`, or a refused launch. Once the reason is cleared, the next evaluation delivers the return again.
- When automatic continuation has stopped because it is unknown whether an instruction arrived (`receiptUnknown` in `task returns`; "Receipt unconfirmed" in [the user's turn](lifecycle.md#waking)), that is not proof that the instruction did not arrive. Send an ordinary `task request` to the same task.
- A Run's `reason` is one of the following. For a failure (`failed`): `launch` (could not start), `exit` (ended with a code other than 0), `output` (a conversation ID mismatch or an invalid reply), `timeout` (exceeded `limits.run_minutes`), `conversation_busy`, or `attachment_save`. For a Run that was stopped (`cancelled`): `stopped` or `scope_invalidated`. For `needs_review`: `manager_lost` or `conversation_busy`.
- When a Run stays queued (`queued`) and does not advance, check whether every parallel slot (`limits.parallel`) is taken, whether a Run of the same conversation is running, whether `config.yaml` cannot be read, and whether an update's switch has not finished.
- A request refused with `too_deep` or `too_many_children` has reached a limit, and nothing was added (["Run limits" in Configuration](config.md#run-limits-limits)).

## Stopping for maintenance

This is the order for stopping Runs before maintenance during which you do not want agents to be relaunched (such as an update that changes the shape of the database). Hold comes first because the return from `run stop` can wake the owner of the requester task, which may then request the same work again.

1. Read the Runs to stop with one `run list` (`--under <ID>` for part of the tree), following `cursor`. A task in any state, `todo` included, can have them. A list with `errors` is incomplete, and inside a Run it covers only that Run's project (`scope`).
2. Put on hold each task that has one and each requester task its return would wake (hold is a mark on each task; holding an ancestor does not hold the tasks under it), with each task's hash from `task get`. Leave a task already on hold as it is.
3. Stop them with `run stop`, `queued` first. Stopping a Run also stops the Runs under it (`parentRun`), so leave your own Run (`ALPACAWORK_RUN`), the Runs above it and `coordinator` Runs, which end with their reply.
4. Before the maintenance, confirm with `run list` that only those remain (`stopRequested` ones are still ending); send no new requests and take nothing off hold meanwhile. If an update still reports Runs, see `run list -h`. Afterwards take the holds off from the upper tasks down ([Hold](lifecycle.md#hold)); treat the results of stopped tests as missing and verify reruns separately.

When the server is down and `run stop` cannot be run, a person runs `alpacawork run stop-local` on the server machine (give a UUID explicitly in `--op-id`). The Run stops without waiting for the server to come back. The record reflects it only after the server has come back.

## config.yaml cannot be read

- The server does not fall back to default values. New Runs do not start, and the screen is treated as unable to write. Runs already running can finish. An update's switch does not go through either, so fix this first.
- The cause is an unknown key, a missing `agents`, a key in an old form, or a YAML error. The screen shows the reason under "Settings → AI". Once `config.yaml` is fixed on the server machine, the waiting Runs start without a restart.

## The server does not start

Tell errors apart by their text, not by their code (such as `conflict`), because the same code is also used for other causes.

| Error text | What to do |
|---|---|
| `Another serve writer owns this workspace` | Another server or a maintenance process is running on the same data folder. Stop that one first |
| `requires … explicit migration` (including `Unsupported control database version`) | The database version and the version that was started do not match. Read the version numbers in the text. If the database is newer, the command was run with an old version, so run it again with the running version's `backend.mjs`. If the database is older, confirm that every Run has ended, stop the server, and back up the data folder (see "Data" below); then read it with `workspace maintenance --mode inspect` and, if the version is a supported one, migrate it with `--mode migrate` |
| `integrity check` | The database is corrupted. There is no repair command. **Do not delete the file and start again** (all data would be lost) |
| `Release maintenance is incomplete`, `Located switch journal is missing` | An update's switch has not finished (see "An update stopped partway" below) |
| `unsupported_platform`, `sandboxed_caller` | The machine cannot run it, or it was started inside a sandbox or as root on Linux |
| `already_initialized`, `Incomplete workspace` | The data is already initialized, or there is data whose initialization stopped partway. Do not repeat init (see "Initialization stopped partway" below) |
| `Installation belongs to another user` | The installation record belongs to another OS user. Do not move the record; run the command again as the user who installed it |
| Text containing `troubleshoot.md#installation-record`, other than the row above, and `Managed service installation record is missing or differs` | The installation record and what actually exists do not match (see "Installation record" below) |
| `Node.js is now … but this installation approved …` | The real path of Node.js has changed since the installation. Run `alpacawork setup --yes` again; it prints the changes it makes (["Change the installation" in Setup](setup.md#change-the-installation)) |
| Text beginning with `Installation management facts differ` or `Service installation record differs from` | The installation record does not match the data folder, the releases folder, or the like (see "Installation record" below) |
| `Different workspace candidates` | There is more than one candidate for the data folder. Give the location explicitly with `--workspace` |
| `EACCES`, `EPERM`, `EROFS`, `ENOSPC` | The path shown cannot be written to, or there is not enough space. Do not move the record aside |

## An update stopped partway

Before running anything again, read the current state: `current` and `previous` in `release status`, and `phase` and `target` in `switch.json` in the releases folder. Decide the next step from `phase`, not from the exit code.

| `phase` | Meaning and next step |
|---|---|
| `committed` | The switch is complete. If `current` is the version you wanted to install, confirm that the server is running and do not run the command again |
| `aborted` | The switch was cancelled and the server is back on the previous version. The reason is in `abortReason`. Fix the cause, then run the same command as the first time |
| `recovered` | The recovery by `release recover` is complete |
| Anything beginning with `recovery_`, or `waiting_runs` that has `recovery` | `release recover` is partway through. Continue with the same `release recover`, giving the same `--backup`. A switch to another version is refused until the recovery finishes |
| Anything else | The switch has not finished. Run the command again in the form below to resume. A switch to another version is refused until this switch finishes |

- To resume, run `alpacawork deploy` again, giving the same version from the same source (the same version for npm, the same commit for a repository).
- Do not work around it by deleting `switch.json` or starting the service by hand. Do not delete `current`, `previous`, or the running version's folder by hand.
- `Execution FORMAT differs` and `Database migration requires all Runs to naturally end` are refusals saying that unfinished Runs remain (["Update" in Setup](setup.md#update)). Do not delete records to get past them.
- `release rollback`, which returns to the previous version, cannot be used after an update has finished (because an update overwrites the skills). It is also refused when the database is newer than the previous version. Fix a problem that appears after an update by moving forward, to the same version or a newer one.
- `release recover --backup <backup>` restores the database and `config.yaml` to the backup that the switch took before migrating (`backup` in `switch.json`; it is under `backups/` in the releases folder), and starts the previous version's server. **Tasks, requests, Runs and records from after the time of the backup are lost** (task files are not restored). It can be used only when that switch stopped before it began overwriting the skills. Run it only after the update process and all running Runs have ended.
- After restoring, do not resend, under a new operation ID, an operation that was sent under an earlier one. If `operation get` answers that the operation is from before the restore, read its result with `release operation --backup <backup> --op-id <operation ID>`.
- When an update started from the screen has stopped, "Continue" or "Try again" on the update row in Settings performs the same resume.

## Data

The data folder (default `~/alpacawork`) holds all the records of tasks and Runs. It contains secret keys and history, so do not hand it to anyone. The installation record (`~/.config/alpacawork/`), the releases folder (versions, `switch.json`, and the backups taken by switches), the skills, and the place where each AI stores its conversations are outside the data folder.

| Location | Contents |
|---|---|
| `config.yaml` | Server settings |
| `tasks/` | Task files |
| `.alpacawork/` | The records of tasks, requests and Runs themselves, secret keys, and personal settings. Do not delete or rewrite it by hand |

- There is no command for taking a backup by hand. To back up, stop the server when no Run is running and copy the whole folder with its permissions preserved (with `cp -a` or the like). Do not copy only the files of a running database.
- There is no procedure for restoring from a backup taken by hand. `release recover` can restore only a backup that a switch took.
- Archiving or deleting a task is not a way to erase secrets (the files remain).

<a id="installation-record"></a>

## Installation record

When the installation record (`${XDG_CONFIG_HOME:-~/.config}/alpacawork/installation.json`) and what actually exists (the data folder and auto-start) do not match, the server refuses to start.

This procedure resolves the mismatch; it does not guarantee that data is moved or restored. Once the record is moved aside, the registered auto-start refuses to start, and updates no longer work. Tell the user about this consequence first. The steps are as follows.

1. Confirm that no Run is running, then stop the server and auto-start.
2. Do not rewrite the record's contents by hand; move it aside to another name that is not in use (`mv -i`; do not overwrite a destination that already exists). Check the location of the data you want to use and its backup.
3. Start the server by hand, giving the existing data you want to use: `<releases folder>/current/bin/backend.mjs --workspace <absolute path of the data> workspace serve --port <previous port>` (also `--public-host <previous name>` if it was opened from other devices). The previous values are in `service` in the record that was moved aside. Do not run init.
4. Keep the record that was moved aside and the backup of the data until the checking is finished.

Starting the server this way does not recreate the record. To bring auto-start and updates back, stop the server that was started by hand; the user then runs `alpacawork setup --workspace <absolute path of the data> --port <previous port>` (with `--public-host` if needed) in a terminal and installs again over the existing data. This procedure as a whole has not been verified on a real machine, so read what setup shows for confirmation before going ahead.

<a id="interrupted-init"></a>

## Initialization stopped partway

`Incomplete workspace` means that the data folder has a metadata folder but no database or marker. Ask the user whether this is existing data or a first installation that stopped partway.

- If there is existing data, do not delete it. Stop the server and read it with `workspace maintenance --mode inspect`. There is no feature that recreates a missing database.
- Only when it is confirmed that the first installation stopped partway and that there is no user data yet: stop the server and the agents, move the folder aside to another name that is not in use (`mv -i`), and start over. If it was installed with setup, run `alpacawork setup`; if it was initialized by hand, run the `workspace init` given in the error text.
