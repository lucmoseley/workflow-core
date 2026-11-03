# CLAUDE.md

@AGENTS.md
@.claude/workflow-core.md

<!-- Repo-owned. workflow-core's init writes this file ONCE and never touches it
     again. Everything below is yours to edit. The workflow rules live in
     `.claude/workflow-core.md`, which is rewritten on every core bump — do not
     edit that file; override through `.claude/workflow-core.json` (`overrides`,
     `disabled`) instead. -->

## Project

{{project}} — <one line: what it is and who it is for>. Founder: {{founder}}.
State: <pre-launch / live / …>.

- Claude model and effort policy: the core's `docs/effort-guide.md`, in the plugin root.

## Ground truth

<!-- Where the truth about THIS project lives, and which file wins when two disagree.
     Keep it to what a session must know before its first edit. -->

- Where two rules conflict, the more specific wins, and a guard's deny text wins over any file. `CLAUDE.md` beats `AGENTS.md`; both beat the harness's own defaults.

## Commands

<!-- Only what `.claude/workflow-core.json`'s `commands.*` declares. A command absent
     there means "this repo has none", and the core's checks skip it saying so. -->

{{commands}}

## Conventions specific to this repo

<!-- Formatter of record, source layout, deploy trigger, and any rule that exists
     only because of THIS product. Workflow-wide conventions are already in
     `.claude/workflow-core.md`; do not restate them. -->

## Gotchas specific to this repo

<!-- Things a session will get wrong here that it would not get wrong elsewhere. -->

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it, and this region is the one CLAUDE.md must carry. -->

<!-- A rule of THIS repo's with a guard behind it goes here. -->
<!-- guard-registry:end -->
