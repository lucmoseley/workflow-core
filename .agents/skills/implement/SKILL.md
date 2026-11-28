---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Right after claiming a ticket, run `node scripts/read-hand-off.js <n>`. Where a parked session left a `**Hand-off:**` block on it, the script checks that its Base is an ancestor of HEAD, that each Done sha is on the pushed ref (the session's own queue ref where it stands) and that its diff passes `git apply --3way --check`. On `Usable`, apply the diff and continue from its Left line; on `Reference only`, say so on the ticket and start from HEAD (#2391).

Run typechecking regularly, single test files regularly, and the repo's test command once at the end: `commands.test` in `.claude/workflow-core.json`, which `node scripts/lib/workflow-core-config.js command test` prints (`scripts/` is the workflow-core root, the installed plugin in an adopter). Where that is workflow-core's own `npm run test`, it narrows to your own unpushed commits and uncommitted files (#1216); `test:changed` reads only the uncommitted ones, and `--changed <ref>` takes on every neighbour commit in its range (#2182). There it selects the tests that read a changed document or fixture as well as those that import a changed module (mantahostels#2095), so a document change owes no full suite (#1147).

A subagent you dispatch runs its touched files' tests in one call of that command, every touched file as an argument (`<commands.test> <file> <file>…`), when its work is done — never one call per file — and its brief names the command. Per-file runs from parallel agents queue against each other and exhaust memory (#1517).

Once done, use /code-review to review the work — through the Skill tool, `workflow-core:code-review` in a project with no `.claude/skills/code-review/` of its own, where a bare `code-review` is the harness's built-in reviewer (#1165).

Commit your work to the current branch.
