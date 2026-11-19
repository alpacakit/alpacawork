# Security Policy

## Supported Versions

Security fixes are made only in the newest release published on npm and ship as a new release. Older releases are not patched, so update to the newest release before reporting.

| Version | Supported |
| --- | --- |
| Newest release on npm | Yes |
| Any earlier release | No |
| Canary builds (`0.0.0-canary...`) | No |

If you find a problem in a canary build, report it if it also affects the newest release.

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Send your report by email to:

```text
alpacaloop0000@gmail.com
```

Use this subject line, with a short summary in place of the brackets:

```text
[alpacawork security] <short summary>
```

Copy this template into the body and fill in each field. We may not be able to ask follow-up questions, so include everything needed to reproduce the problem:

```text
Affected version(s):
  (output of `alpacawork --version`, or the commit you tested)

Environment:
  (OS, Node.js version, browser if the screen is involved,
   and how the server is reached: this PC only, a VPN such as Tailscale, or other)

Summary:
  (one or two sentences: what an attacker can do)

Steps to reproduce:
  1.
  2.
  3.

Impact:
  (who can exploit it, what they need first, and what they gain)

Proof of concept or logs:
  (optional; remove tokens, passwords and personal data first)

Suggested fix:
  (optional)

Name or GitHub username for credit:
  (optional; leave blank if you do not want to be credited)
```

Write the report in English or Japanese.

## What to Expect

Thank you in advance for reporting responsibly. We read every report, but may not reply to each one individually. When a report leads to a fix, the fix ships in a new release with a security advisory (see Disclosure Policy).

There is no bug bounty.

## Disclosure Policy

When we confirm a problem:

1. We prepare a fix and publish it as a new release on npm.
2. We then publish a security advisory on GitHub, and mention it in the release notes, describing the problem, the affected versions and the fixed version. If you gave a name or GitHub username for credit, the advisory credits you.

Please keep the details private until a fixed release is published or 90 days have passed since your report, whichever comes first.

## Out of Scope

alpacawork is a tool for **one person on their own computer**. The following are how it is designed to work, and are not treated as vulnerabilities on their own:

- **AI agents run commands without asking.** Agents (Claude Code, Codex and others) start as the user who runs the server, by default with their approval prompts turned off (pi has none), and can read, change and delete any file that user can reach.
- **The screen and the API have no login.** The server listens on `127.0.0.1` (port 5499 by default). Anyone who can reach it can do everything you can, including making agents run commands. This includes other OS users and any program on the same computer.
- **Opening it to other devices adds no authentication.** `--public-host` and an HTTPS entry such as Tailscale Serve only let more hosts reach the server. Exposing it to the internet (for example with Tailscale Funnel or router port forwarding) is unsupported.
- The run markers (`ALPACAWORK_RUN`, `ALPACAWORK_RUN_TOKEN`) separate roles between agents. They are not OS isolation: an agent running as the same user can read the same files and act as the user. `--quote` only records the user's words; it is not checked and grants nothing.
- **Stored data is not encrypted.** What agents read or print is kept in the workspace folder, and in the browser storage of any device that opened the screen.
- Problems in the AI CLIs, model providers or other third-party services alpacawork starts or sends data to. Report those to their maintainers.

A report is in scope if it breaks a boundary that alpacawork does claim, for example a web page on another site acting on the server through the browser, reading or writing outside a task's folder through task files, or secrets showing up where alpacawork says they are hidden.

These design choices and how to use alpacawork safely are explained in [Getting started](docs/getting-started.md). Read it before installing.
