# Contributing to alpacawork

Thank you for your interest in alpacawork. One maintainer runs this project, so replies to issues and pull requests may be slow or may not come, and a pull request may be closed without review.

## Issues and pull requests

- Report bugs and suggest changes in GitHub [Issues](https://github.com/alpacakit/alpacawork/issues). Do not report vulnerabilities in an issue; follow [SECURITY.md](SECURITY.md).
- Ask how to use alpacawork in [Discussions](https://github.com/alpacakit/alpacawork/discussions).
- Open a pull request directly for a small fix. For a larger change, open an issue first.
- Create the pull request from a branch cut from `main`, and fill in [.github/pull_request_template.md](.github/pull_request_template.md).
- For a pull request from a fork, GitHub runs `pnpm test:quick` and shows the result as the `tests` status. A pull request is merged with squash after `tests` passes.
- With a squash merge, the pull request's title becomes the commit title on `main`. Write it as one English sentence saying what changes for the user (for example, `Copy and download an open file from the viewer's head`).
- Contributions are published under this repository's [MIT License](LICENSE).

## Development environment

Use Node.js 24.16 or later and pnpm 11.6.0 on macOS arm64 or Linux x64.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium   # before running browser tests the first time
```

- Do not edit files under `node_modules`: they are hard links into the pnpm store, shared with other worktrees. Fix a dependency with `pnpm patch`.
- Scripts do not install dependencies for you. Run `pnpm install` again after dependencies change.

## Tests

Before opening a pull request, run the tests related to your change and `pnpm test:quick`. Run `pnpm test:all` only when a change cannot be checked by its related tests and quick.

```sh
pnpm test:quick                           # build, type checks, pure Node tests, browser smoke tests
pnpm test:quick --area reader-answer      # quick plus one browser test area; a parent name (coordinator) works too
pnpm test:e2e --project='coordinator-*'   # build, then only the browser tests of those areas
pnpm test:web --changed origin/main       # only the web tests related to the change
pnpm test:e2e:offline                     # tests with the real Service Worker and browser restarts (after a build)
pnpm test:acceptance                      # acceptance tests with an isolated fake agent
pnpm test:all                             # everything
```

Browser tests are split into areas by screen and feature (`e2e/areas.ts`). Pick the areas from this table; when unsure, run them all.

| What you changed (`apps/web/src/`) | Areas to run |
|---|---|
| `features/coordinator` | `coordinator-*`, plus `reader-answer` if it touches answering |
| `features/reader`, `features/forms` | `reader-*`; `files` and `history` for file or history display; `coordinator-*` for the Markdown, attachment and image parts, which the conversation also uses |
| `features/tree` | `list`, `history` |
| `features/chrome`, `features/panels`, `features/shell`, `features/archive` | `shell`, `list` |
| `components`, `data`, `state`, `lib`, `domain`, `styles.css`, `apps/backend`, `packages` | all (they are used across many screens) |

- Put a new `e2e/*.check.ts` in exactly one place in `e2e/areas.ts`: one of the areas, or `e2eOffline`. A test that needs the real Service Worker goes in `e2eOffline` and also in `testMatch` in `e2e/offline-scope.config.ts`; without that it never runs.
- Test stages wait in a queue shared by all worktrees on the machine until memory and CPUs are free, so a stage may not start at once.
- Tests create their own data directories. Do not point tests or the dev screen at a workspace you use.

### Writing tests

Every test costs time on each run and work on each change. Add one only when it pays for that.

- Write a test for behaviour that would hurt users if it broke, and that type checks and the existing tests would not catch. A refactor or a wording change needs no new test.
- Put it in the cheapest layer that can check it: rules and calculations in Node tests (`tests/`); one screen's display and interaction in web tests (`apps/web/tests/`, jsdom); only what needs a real browser (layout, scrolling, touch, focus, the Service Worker) in browser tests (`e2e/`). Before adding a browser test file, see whether a step in an existing check covers it.
- After fixing a bug, add the smallest test that stops it from coming back.
- When you remove or rework a feature, remove the tests that guarded only that feature in the same change. When you find a slow or flaky test, speed it up or replace it with a cheaper one.
- Do not write tests that copy wording, class names, DOM structure or snapshots, count internal calls, check constants or what the types already guarantee, or add cases for one rule that check nothing the existing cases do not. Do not weaken or skip a failing test to make it pass.

### Test parallelism

Set it per machine in environment variables or `.env`, as described in [.env.example](.env.example). `node scripts/testing/queue.ts settings` shows the values in effect.

## Running from source

Start the built server on an empty directory for testing. Do not point it at the data directory you normally use (such as `~/alpacawork`).

```sh
pnpm build
node apps/backend/dist/backend.js --workspace /absolute/empty-dir workspace init
node apps/backend/dist/backend.js --workspace /absolute/empty-dir workspace serve --port 0
```

`serve` prints the URL it started on and stops with Ctrl-C. Send CLI commands to that server with `node apps/cli/dist/cli.js --server <URL> …`. Start the dev screen with the test backend named explicitly (for example, `ALPACAWORK_DEV_BACKEND=http://127.0.0.1:5688 pnpm dev:web --host 0.0.0.0`). For a screen filled with made-up data, use the tools in [scripts/dev-fixtures/README.md](scripts/dev-fixtures/README.md).

## Code rules

- Write code, comments, commit messages, pull requests and new documents in English. When adding to an existing document written in Japanese, write in Japanese.
- Fix the underlying mechanism; do not add a compatibility layer for an old shape or a branch for one case.
- When you add, change or remove UI text, change the same key in every locale under `packages/i18n/src/locales/` and pass `pnpm i18n:check`. [packages/i18n/README.md](packages/i18n/README.md) explains how keys are named.
- Before changing the database schema, read [packages/db/README.md](packages/db/README.md). Migrations are only appended in date order; existing migrations are never regenerated.
- There is no formatter. Follow the surrounding code.

## Skill tools

Tools for a shipped skill (`skills/`) go in that skill's `scripts/`, in a form that runs with the skill alone.

## Adding an agent

Implement the run bridge in `apps/agent-cli/src/` and register it in `cli.ts`; add the kind to `packages/contract/src/agent-adapters.ts` and the skill location to `apps/backend/src/installation/agent-skill-links.ts`. Check starting, continuing, results and stopping with the real agent, and update the tests, the list of supported agents and the setup guidance with it.
