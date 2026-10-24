---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Run typechecking regularly, single test files regularly, and `npm run test` once at the end. It narrows to your own unpushed commits and uncommitted files (workflow-core#1216); `test:changed` reads only the uncommitted ones, and `--changed <ref>` takes on every neighbour commit in its range (workflow-core#2182). It selects the tests that read a changed document or fixture as well as those that import a changed module (mantahostels#2095), so a document change owes no full suite (workflow-core#1147).

A subagent you dispatch runs its touched files' tests in one `npm run test -- <file> <file>…` call when its work is done — never one call per file — and its brief says so. Per-file runs from parallel agents queue against each other and exhaust memory (workflow-core#1517).

Once done, use /code-review to review the work — through the Skill tool, `workflow-core:code-review` in a project with no `${CLAUDE_PLUGIN_ROOT}/.claude/skills/code-review/` of its own, where a bare `code-review` is the harness's built-in reviewer (workflow-core#1165).

Commit your work to the current branch.
