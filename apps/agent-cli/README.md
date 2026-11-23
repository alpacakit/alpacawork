# Agent CLI

`alpacawork-agent <agent> [agent options]` connects Codex, GitHub Copilot, Grok Build, or pi to alpacawork's line-oriented `{id,text}` stdin and JSONL stdout.

- `src/cli.ts` selects the agent.
- `src/run.ts` owns stdin validation and ordering, instruction outcomes, stdout serialization, signals, and exit status.
- Each agent module owns that agent's options, connection, and event translation.

External runtimes accept `alpacawork-agent <agent> --command /absolute/path/to/executable [agent options]`. The backend resolves `agents.<name>.command` (or the server's PATH when unset) at admission and keeps that path in the Run's launch snapshot. A missing explicit executable fails without falling back to PATH. The bundled Copilot runtime does not accept a command path. `alpacawork-agent copilot --auth-status` checks authentication without creating a conversation; exit codes are 0 for signed in, 1 for signed out, and 2 for a failed check.

## Codex history

With `CODEX_HOME` unset, the Codex wrapper stores new conversations in `~/.codex-alpacawork`, separate from the desktop's `~/.codex`. Conversations stay persistent and later Runs resume the same thread. A configuration-only app-server first reads the original configuration; it never opens a thread there. File authentication (`auth.json`), configuration, `.env`, instructions, agents, skills, rules, plugins and hooks are linked to the original inputs. Authentication tokens are never copied or printed. Known configuration input paths inside the original home are linked by their root directory; sibling placement preserves `../` references. SQLite and logs are forced into the dedicated home.

Automatic preparation supports file authentication (including the default with an existing `~/.codex/auth.json`). A missing credential, explicitly different credential store, conflicting destination input or linked session/state directory fails before opening a thread. It never falls back to desktop storage. Unsupported authentication can instead be configured by signing in with Codex's official CLI under an explicitly chosen dedicated `CODEX_HOME`. Explicit `CODEX_HOME` is used as supplied: the wrapper does not share inputs, override storage or change that directory. Point it at a dedicated home when desktop separation is wanted.

Existing conversations remain in their original home; they are not moved or archived. When resuming a specific ID found in the original sessions directory, the wrapper uses that original home, reports this on stderr and verifies the returned ID. Its existing desktop visibility remains. New conversations use the dedicated home by default; a failed resume never starts a replacement conversation.

`threadSource="exec"` is analytics metadata, independent of the `source` used by the history list. Setting it, or separating SQLite alone, does not isolate desktop history (verified with real Codex 0.159.3 and 0.162.1 on Linux). Desktop UI on macOS requires manual confirmation.

For an opt-in real check on a Mac with Node 24+, file authentication and access to `gpt-6.1-sol`, build the repository, then run `node --test tests/manual/codex-isolation.ts`. It uses a disposable home and 4 short model turns to verify shared file authentication, relative instructions, the skill catalog, separate session/SQLite storage and resume from another process. A second new fixture simulates an older conversation and verifies continuation in place. It never opens an existing managed conversation. The JSON result distinguishes these checks from the desktop UI check.

To add an agent, implement `Runtime` from `run.ts` in its own module, register it in `cli.ts`, and add its built-in description (initial rows, prefix, default options, fixed environment names, executable name, model-free sign-in check, next setup action, reference URL) to `packages/contract/src/agent-adapters.ts`. Users cannot add a kind from configuration; a new kind ships with a release. `deliver()` returns whether the remote side admitted the instruction; the runtime calls `io.started(id)` only when it has evidence that processing began, and `io.idle()` when its turn ends. Only `run.ts` emits `input.accepted`, `input.taken`, and `input.refused`. The backend distinguishes transfer not started (`not_sent`), uncertain receipt, and evidenced processing (`taken`); an `input.refused` name alone does not prove whether processing began. Signals and faults can leave receipt uncertain. Copilot waits through SDK queued turns until `session.idle` rather than claiming a queued message was processed when merely admitted.

## Using these agents from `config.yaml`

Every agent here is a built-in kind. Configuration only chooses which kinds to use and in which order, the values offered when assigning work, optional edits after the locked `alpacawork-agent <kind>` prefix, and the names of extra environment variables. How a kind is launched, how instructions are taken, how results, sessions and usage are read is owned by this wrapper and the backend adapter, not by configuration. The format is summarised in `alpacawork config get -h`, each kind's default options are in the `catalog` that `alpacawork config get` returns; use `alpacawork config inspect` for executable and sign-in observations, and the settings an agent may change are described in the alpacawork skill ([references/config.md](../../skills/alpacawork/references/config.md), Japanese).

```yaml
agents:
  codex:
    params:
      model: [gpt-6.1-sol]
      effort: [high]
      fast: [-, fast]
    env: [OPENAI_API_KEY]
```

Write only variable names in `env`; values stay in the alpacawork server environment and are never stored in `config.yaml` or Run records. Do not put credentials in launch options or URLs: they are shown in settings and kept in Run records.

Copilot uses the bundled runtime from `@github/copilot-sdk@1.0.14` when launched for real.

Pi is launched as `pi --mode rpc`. The model is one `provider/id` value; the effort row is passed as `--thinking`. The wrapper checks the session ID, cwd and model reported by `get_state` before sending, treats only a settled normal stop as success, and reads usage from the conversation's session stats. `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are passed by the adapter. `--approve`/`--no-approve` set project trust, not tool permissions; by default neither is passed and pi's saved trust applies. Pi has not been run for real with alpacawork.

**Real-run check (2026-11-12, Linux):** with the bundled runtime (1.0.85) signed in through GitHub CLI, starting a new conversation, continuing the same conversation, and stopping mid-turn (the running turn is cancelled, and the relay command and the bundled runtime exit) work. Not yet run for real: adding an instruction during a turn (tested only against a fake SDK JSON-RPC peer, following the [SDK steering documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing) and the `@github/copilot-sdk@1.0.14` type definitions), and macOS.

## Coordinator launches

Every enabled agent can be the screen's coordinator, using the same setting (kind, selectable values, options and extra environment names) as its other Runs. It runs in an empty `.alpacawork/coordinator/cwd` without a Run credential. There is no separate coordinator launch field. An old `agents.<name>.coordinator` launch block is not removed automatically: if one is left, the settings migration stops and names a path inside that block. Remove it and run the migration again.
