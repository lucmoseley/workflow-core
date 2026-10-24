# The ceiling on agent autonomy

How far agent work may go here on its own authority. Ruled by the founder at mantahostels#1169.

## "Unattended" is not the axis

*Unattended* makes a session a human started but stopped watching indistinguishable from one a cron started, and a cron that only files an issue indistinguishable from one that pushes to `main`. Two independent dials replace it: **trigger** and **blast radius**.

## Dial 1 — trigger

**Human** or **timer**.

> A **driven session** is a Claude Code session whose start was caused by a human action in the current sitting — a typed prompt, or a dispatch set launched by a command the human typed — or that away mode's refill loop launched up to 24 hours after the human last started or renewed the loop with a command he typed (#1897). Its opposite is a session started by a timer.

The loop's own tick is not a timer start: every launch traces to that typed command, and none is made after its 24 hours.

The term is the one `docs/agents/guard-registry.md` §Conventions already rests on: *"hand edits and agent work in a driven session commit directly to `main`"*. **It says nothing about whether anyone is watching when the session writes** — that is dial 2's business.

## Dial 2 — blast radius

- **R1** — file or refresh a GitHub issue.
- **R2** — commit and push to `main` in this repository.
- **R3** — write any surface outside this repository: Supabase, Vercel, an OTA, claude.ai project knowledge.

## The standing line

- **Timer-triggered work is capped at R1.** No workflow may acquire `contents: write`, and **nothing on a timer may start a Claude Code session or a Claude routine.** A workflow declaring no `permissions:` block at all runs on the repository's default token, which is unreadable from an agent session — HTTP 403 on `actions/permissions/workflow` — so it cannot be checked by looking it up (mantahostels#1209).
- **Human-triggered work may reach R2** — what every ordinary session here already does, and what a `/pick-next` dispatch set inherits rather than escalating past. **So mantahostels#1153's self-launching `/pick-next` is within the line and needs no change.**
- **R3 is barred on both dials**, by `CLAUDE.md` §Conventions' write-scope rule.

**mantahostels#813 is not an autonomy ruling** and cannot be cited as one: it ruled on cadence, and the *"never a PR"* it produced at `docs/agents/guard-registry.md` §Conventions bars PRs, not unattended work.

## What moves the line

The repo being able to **observe a failure**: deployed software a failure can be acted out against, plus a rollback path (mantahostels#1166, *What release strategy and rollback does Manta need, and when?*).

**Never a count of clean unattended runs.** A clean run against a static landing page with no provisioned infrastructure measures almost nothing.

## `incident-agent` is disjoint, not subsumed

That parked roadmap card's *"Diagnose-and-propose only — it never deploys, never rolls back, never writes to Supabase or Vercel"* constrains **R3**, which this ceiling does not reach. Folding `incident-agent` into this one would silently delete a constraint: a Supabase write would become permissible the day the repo ceiling rises.

## Enforcement

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. -->

- **No workflow job may hold a write scope beyond `issues: write`, and no workflow step may `git commit` or `git push`.** **Enforced** (mantahostels#1209, #1380): `scripts/check-workflow-permissions.js`, in `.husky/pre-commit` on a commit adding or editing a workflow, in the scheduled `Document guards` job and `npm run check:workflow-perms` by hand. In an adopter it runs from the plugin and reads js-yaml from the repo's own install, refusing the commit where there is none. An adopter is held to the same ban, with no per-repo opt-out: a push-triggered deploy job takes its write token from outside the workflow's own `permissions:` block (#1539). A job with **no** `permissions:` block, its own or its workflow's, or one whose value it does not recognise, fails alongside one granting `contents: write` — silence is not a grant of read. It reports the number of jobs it inspected and fails on zero, so a run that found no workflow files cannot report green.
- **Nothing on a timer may start a Claude Code session or a Claude routine.** **Unenforceable**: claude.ai/code/routines is a surface Claude Code cannot read, so nothing here can observe a routine re-enabled there, and a green run of the guard above says nothing about it.
- **A git-hook escape — `WFC_ALLOW_BRANCH`, `WFC_ALLOW_GATE_INPUT_DELETE` — is the founder's to set, never an agent's; a refusal naming one hands over the decision, not the command.** **Enforced** (#916): `scripts/guard-hook-escape.sh` denies a Bash command assigning or exporting one and prints the whole rule (`rule:hook-escape`). Lexical, so it misses a `sh -c` string, `eval`, a wrapper script, an unquoted `NAME=$(…)` value and an export persisted from an earlier call — the header's LIMITS lists each.

<!-- guard-registry:end -->
