# Dependabot and the security alerts

Read this when a Dependabot pull request is open, or when the GitHub UI shows a count under *Security and quality*.

## Never merge the PR

`docs/agents/guard-registry.md` §Conventions bars a session from opening a PR: hand edits and agent work commit direct to `main`. That rule binds **sessions**. Dependabot is a GitHub app, so a PR is the only shape it has, and its PRs were never covered.

They also cannot clear themselves. `.github/workflows/ci.yml` is `workflow_call` / `workflow_dispatch` only, with no push or pull_request trigger (mantahostels#906, mantahostels#910), so a Dependabot PR never gets a check run, never goes green, and hangs until a human notices the badge.

<!-- rule:dependabot-merge:begin -->
**Never merge a Dependabot PR — take its fix locally and commit it direct to `main`.**

```
npm update <package> --package-lock-only
npm install --ignore-scripts
```

Then commit `package-lock.json` alone, direct to `main`. That recipe covers a transitive package and a caret-ranged direct one, and `package.json` stays untouched.

**A direct dependency pinned to an exact version is the exception — `npm update` will not move an exact pin**, so it reports `up to date` and the advisory stays open (mantahostels#3560). Edit the pin in `package.json` to the fixed version by hand first, then re-resolve and install:

```
npm install --package-lock-only --ignore-scripts
npm install --ignore-scripts
```

Commit `package.json` alongside `package-lock.json`.

**Close the PR by deleting its head branch — `git push origin --delete dependabot/npm_and_yarn/<branch>`, the name read off `gh pr view <n> --json headRefName`.** GitHub closes a same-repo PR the moment its head ref is gone, and the PAT's `contents` write reaches that where its `pull_requests` write does not: `gh pr close` (`closePullRequest`), a PR comment (`addComment`) and the REST issues endpoint (`PATCH /repos/{o}/{r}/issues/{n}`) all answer `403 Resource not accessible by personal access token` (mantahostels#3351, mantahostels#3358).

`--ignore-scripts` is not optional: `scripts/guard-dispatch.js` (its `guard-npm-install` core) denies the install without it, because a package's `preinstall` and `postinstall` run as you before anything reads a byte of it (mantahostels#1767).

**`npm install` can report `up to date` and leave the old version on disk** while `npm ls` reads the new one out of the lockfile. Check the installed copy directly — `grep -m1 '"version"' node_modules/<pkg>/package.json` — and where it disagrees, `rm -rf node_modules/<pkg>` and install again (mantahostels#3351).

`scripts/guard-dispatch.js` (its `guard-branch-publish` core) refuses a `gh pr merge` of one, printing this rule. **It does not catch** a merge through `gh api`, the GitHub web UI or a script, nor a `gh pr merge` whose PR it cannot look up: an unreadable PR or repo word, a `GH_REPO` override, or a failed lookup. Its silence there is not leave.
<!-- rule:dependabot-merge:end -->

## Read the alerts with `npm audit`, not the API

This repo's `gh` PAT has no `security_events` scope, so `gh api repos/<tracker>/dependabot/alerts` answers `403 Resource not accessible by personal access token`. Secret scanning answers the same. Code scanning is not enabled at all, and says so rather than 403-ing.

`npm audit --json` reads the same GitHub advisory database and needs no scope. Tie its findings to the badge by count: where the badge's number and the audit's advisory count agree, they are the same set.

**`npm audit` cannot see a dependency a package vendors into its own tree.** `next` ships `node_modules/next/dist/compiled/browserslist` with no version field at all — unversioned, unreachable by any lockfile change, and invisible to both audit and Dependabot. A vendored copy is fixed only by upgrading the package that bundles it.

## Judge exposure before treating an advisory as urgent

Trace the dependency path — `npm ls <package> --all` — before reading a CVSS score as a live risk. A dev-only package reached through the lint toolchain never enters a client bundle, and an availability-only advisory (`A:H` with `C:N/I:N`) against a build-time tool with no untrusted input is not a production exposure. Fix it anyway, because the fix is cheap; do not escalate it.

## What the config does

`.github/dependabot.yml` governs **version** updates only, and sets `open-pull-requests-limit: 0` on both ecosystems, so Dependabot opens none. A routine bump earns little on a pre-launch repo with three production dependencies, and an open PR should mean an advisory.

**Security** updates are a repository setting, not a key in that file, and the limit does not reach them — so an advisory still opens a PR. That is the only shape of Dependabot PR this repo expects to see.

Routine bumps are not grouped instead: one npm PR a week and one actions PR a month still put them on the tab needing weekly disposal, which is the thing the tab is meant to stop meaning (mantahostels#3351).
