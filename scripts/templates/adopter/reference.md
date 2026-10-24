<!-- TEMPLATE for .claude/workflow-core.reference.md, rendered by scripts/lib/adopter-skeleton.js.
     A `node scripts/…` command is spelled at the plugin root; core-owned-files.js
     appends the plugin provenance block. -->
<!-- CORE-OWNED. Written by workflow-core's init and REWRITTEN on every bump.
     Do not edit, and never import it. -->

# Workflow core — reference

## Switching a module on

The modules are `roadmap`, `governance`, `suites`, `site`, `mutation` and `landing`; `landing` stays off until a release turns it on. To switch one on, add it to `modules` in `.claude/workflow-core.json`, then run `node scripts/init-adopter.js --no-plugin-install`: it keeps the founder, modules and plugin pin already written. Commit what it wrote; the new rules load at the next session. Until a subject's switch is set, `check-gate-switches.js` refuses every commit.

## Repo-health checks on demand

The repo-health checkers — stranded claims, stale queue markers and git locks, stray scratch among them — run on demand with `node scripts/status-report.js`, or `--only <part of a name>` for some. A checker's finding never changes its exit code.

## Page checks under `site`

The core's one page check is `check-website-copy.js`, which refuses a commit staging `app/` that adds a banned tell from the brand sheet's §11. Add any other to `.husky/pre-commit.local`.
