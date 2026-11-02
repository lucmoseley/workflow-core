# ci-and-repo-quality-gates

Researched: 2026-10-21

## Commit-message gates: subject length

- Git recommends a short subject of no more than 50 characters, then a blank line, then the body. This is advice ("not required"), not a limit that git enforces. Git uses the subject everywhere, for example as the email Subject in `git format-patch`. git-commit(1) DISCUSSION (Documentation/git-commit.adoc) [standard or field body]
- The 50-character figure is a soft target. Tim Pope: "about 50 characters (though this isn't a hard maximum)", body wrapped at 72 so that `git log` indent fits an 80-column terminal. Chris Beams: "shoot for 50 characters, but consider 72 the hard limit", because GitHub cuts a subject longer than 72 characters with an ellipsis. tbaggery.com 2008-04-19; cbea.ms/git-commit rule 2 and rule 6 [named expert]
- The Linux kernel sets 70-75 characters for the patch "summary phrase". The reason: the summary is a globally unique ID that people search for and read in `git log --oneline` and gitk. Documentation/process/submitting-patches.rst §"The canonical patch format" [standard or field body]
- The kernel's `checkpatch.pl` does not test the subject length by itself. It warns once (WARN, not ERROR) for any commit-log line longer than 75, and it exempts lines that start with `Fixes:`, a URL, a link tag or a sign-off tag. scripts/checkpatch.pl, check `COMMIT_LOG_LONG_LINE` [standard or field body]
- gitlint rule T1 `title-max-length` has the default 72 and an option `line-length` to change it. gitlint docs/rules/builtin_rules.md; gitlint-core/gitlint/rules.py `TitleMaxLength` [standard or field body]
- commitlint `header-max-length` has no default in the base rules. The shared preset `@commitlint/config-conventional` sets it to 100 at error level (body and footer lines also 100). The Conventional Commits spec sets no length. commitlint docs/reference/rules.md; @commitlint/config-conventional/src/index.ts [standard or field body]

## Commit-message gates: characters or bytes

- The tools count different units. gitlint uses Python `len()` on a decoded `str`, so it counts Unicode code points. commitlint uses JavaScript `value.length`, so it counts UTF-16 code units (an emoji outside the BMP counts 2). checkpatch.pl uses Perl `length()` on lines it does not decode, so it counts bytes (a UTF-8 "é" counts 2). gitlint rules.py line 243; @commitlint/ensure/src/max-length.ts; checkpatch.pl line 3333 (code reading only, not tested) [unverified]
- Thus a gate that wants "characters" as the docs say must decode UTF-8 and count code points (the gitlint behaviour). Derived from the rows above, so it sets no default [unverified]

## Commit-message gates: subjects that git writes

- Git writes these subjects itself: `Revert "<subject>"` and, for a revert of a revert, `Reapply "<subject>"` (git-revert(1)); `Merge branch '<name>'` and related forms (git-fmt-merge-msg); `fixup! <subject>`, `squash! <subject>` and `amend! <subject>` (git-commit(1) `--fixup`, `--squash`). Each one adds a prefix to an existing subject, so it can go over a cap that the original subject met. git-commit.adoc; git-revert.adoc [standard or field body]
- gitlint ignores all of these by default, for all rules: `ignore-merge-commits`, `ignore-revert-commits`, `ignore-fixup-commits`, `ignore-fixup-amend-commits`, `ignore-squash-commits` all default to true. It detects them by a title prefix: `Merge`, `Revert`, `fixup!`, `squash!`, `amend!`. It does not name `Reapply`. gitlint docs/configuration/general_options.md; gitlint-core/gitlint/git.py `is_*_commit` [standard or field body]
- commitlint ignores these by default (`defaultIgnores: true`): `Merge pull request`, `Merge X into Y`, `Merge branch`, `Merge tag`, `Merge remote-tracking branch`, `Revert ...`/`revert ...`, `Reapply ...`/`reapply ...`, `amend!`/`fixup!`/`squash!`, a bare semver release subject, `Automatic merge`, and Azure-style `Merged PR`. A config can add `ignores` functions or set `defaultIgnores: false`. @commitlint/is-ignored/src/defaults.ts; docs/reference/configuration.md [standard or field body]
- Common practice: exempt every git-generated subject from a length gate, because `git rebase --autosquash` removes fixup!/squash!/amend! commits before they land. gitlint, commitlint (both by default), two adopters [unverified]; git-commit(1) (`--autosquash` semantics) [standard or field body]

## Commit-message gates: where they run and escape hatches

- Both tools run as a local `commit-msg` hook and also in CI. gitlint: `gitlint install-hook` or a pre-commit hook with `--hook-type commit-msg`; in CI it lints the last commit or a range. commitlint: a husky `commit-msg` hook for local, and `commitlint --from <base> --to <head>` (or `--last`) in CI. gitlint docs commit_hooks.md and ci.md; commitlint docs/guides/local-setup.md and ci-setup.md [standard or field body]
- A local hook is always bypassable: `git commit --no-verify` skips `pre-commit` and `commit-msg`. Thus the CI run is the gate that binds; the local hook only gives early feedback. githooks(5); husky docs how-to.md ("Skipping Git Hooks", `-n/--no-verify`, `HUSKY=0`) [standard or field body]
- Escape hatches that the tools keep: gitlint `ignore-by-title`, `ignore-by-body` and `ignore-by-author-name` rules (regex selects commits and which rules to skip), `gitlint-ignore: all` in a commit body, and `-c` option overrides; commitlint `ignores` and per-rule severity 0/1/2 (off, warning, error); pre-commit `SKIP=<hook-id>`; husky `HUSKY=0`. gitlint builtin_rules.md and ignoring_commits.md; commitlint configuration.md and rules.md; pre-commit.com "Temporarily disabling hooks" [standard or field body]
- Give a scoped bypass (one hook, one rule, one commit pattern) in preference to a full `--no-verify`. pre-commit.com: SKIP "allows you to skip a single hook instead of --no-verifying the entire commit". pre-commit.com [named expert]
- Chromium lets a clean revert skip human code review but never its ownership check: Rubber Stamper "supports … clean reverts that should be exempt from code review" and applies Bot-Commit to them, yet "never provides OWNERS approval, by design", since granting both "would be an abuse vector". chromium/src docs/code_review_owners.md [standard or field body] for Chromium's own process; as a general default one adopter, [unverified], so the default rests on the scoped-bypass entry above.

## Pre-commit hook frameworks

- Use a hook manager that keeps the hook configuration in the repository, because git does not copy client-side hooks on clone. The three main managers, versions read 2026-10-26: pre-commit 4.7.0 (multi-language, each hook in its own isolated environment), husky v9.1.7 (Node, hooks in `.husky/`), lefthook v2.2.2 (Go binary, one YAML file). Pro Git §8.3 "Git Hooks" ("client-side hooks are not copied when you clone"); pre-commit.com; husky docs; lefthook README, each for what it does [standard or field body]. Using a manager rests on the three as adopters, so it sets no default [unverified]
- Pin each hook to an exact version. pre-commit needs `rev` (a tag or a full SHA); `pre-commit autoupdate --freeze` writes SHAs. GitHub tells you to pin each Action to a full-length commit SHA. pre-commit.com "Updating hooks automatically"; GitHub docs "Secure use reference"; OpenSSF Scorecard docs/checks.md [standard or field body]
- Update pins on a schedule by a bot PR, not by hand (pre-commit.ci runs `autoupdate` weekly; Scorecard "Dependency-Update-Tool" checks for one). OpenSSF Scorecard [standard or field body]; pre-commit.ci, one adopter [unverified]
- Give each hook its stage. Put fast checks on `pre-commit`, slower ones on `pre-push`, message checks on `commit-msg`, and on-demand tools on the `manual` stage. A commit-msg hook needs its own install (`pre-commit install --hook-type commit-msg`, or `default_install_hook_types`). pre-commit.com "Confining hooks to run at certain stages"; gitlint docs commit_hooks.md; husky docs, each for its stages [standard or field body]. Which check goes on which stage rests on these adopters alone, so it sets no default [unverified]
- A framework tool that writes fixes (formatters) must re-stage or fail. lefthook `stage_fixed`; lint-staged re-adds fixed files and hides unstaged parts of partly staged files; pre-commit fails the hook when files change, so that the user re-stages. lefthook docs; lint-staged README; pre-commit.com. Three adopters, no default [unverified]

## Fail-closed and fail-open hooks

- A check that cannot run must fail the same way as a check that finds a fault. OWASP: "design your security mechanism so that a failure will follow the same execution path as disallowing the operation". OWASP "Fail securely" [standard or field body]
- Tools differ on a missing binary. The pre-commit hook script exits 1 with "`pre-commit` not found". lefthook skips silently by default and fails only with `assert_lefthook_installed: true`. pre-commit `pre_commit/resources/hook-tmpl`; lefthook docs assert_lefthook_installed.md [standard or field body]
- In CI, a check that did not run can still count as a pass. GitHub accepts a required check with status `successful`, `skipped` or `neutral`. Thus a path filter or an `if:` that skips a required job opens the gate. GitHub docs "About protected branches" (Require status checks) [standard or field body]

## CI gating of the same checks

- Run the same hook set in CI over the full tree or the changed range: `pre-commit run --all-files`, or `--from-ref origin/HEAD --to-ref HEAD`; `npx lint-staged --all`; `gitlint --commits <range>`; `commitlint --from --to`. pre-commit.com "Usage in continuous integration"; lint-staged README; gitlint ci.md; commitlint ci-setup.md, each for its own CI form [standard or field body]. The practice rests on these adopters and githooks(5) above, so it sets no default [unverified]
- Make the CI checks required on the protected branch and do not let admins bypass them. GitHub "Required status checks" and "Do not allow bypassing the above settings"; OpenSSF Scorecard "Branch-Protection" (risk High) and "CI-Tests" [standard or field body]
- Test the merge result, not only the branch, so that main never breaks: "Require branches to be up to date" (strict) or a merge queue / merge train. Google SWE ch. 23 (repository can change while presubmit runs) [named expert]; GitHub merge queue docs ("ensuring the branch is never broken by incompatible changes"); GitLab merge trains docs, each one vendor's product [unverified]
- Fix a broken mainline build at once; it is the team's first task. Fowler "Continuous Integration" (Fix Broken Builds Immediately); DORA "Continuous integration" (pitfall: not fixing broken builds); Google SWE ch. 23 [named expert]
- A check either fails the build or does not show. Do not emit warnings. Google SWE ch. 20 ("We either enable a compiler check as an error ... or don't show it") [named expert]; ESLint `--max-warnings` makes warnings fail, one adopter [unverified]
- Before you turn on a new blocking check, clean up all existing instances, so that the check does not break the build for code that was already there. Google SWE ch. 20 [named expert]
- A blocking check must be actionable and have almost no false positives: Google targets under 10% effective false positives for review-time analysis and none for build-breaking checks, and gives a suggested fix. Google SWE ch. 20 (Tricorder criteria; compiler integration) [named expert]
- Simple metadata checks on a change belong in presubmit (for example, the commit message must not say "DO NOT SUBMIT"). Google keeps a named bypass for large-scale changes (`CLEANUP=` in the description). Google SWE ch. 20 "Presubmit checks" [named expert]

## Keeping gates fast

- Keep the CI commit build at about 10 minutes or less; move slow tests to a later pipeline stage. Fowler (XP "ten minute build", deployment pipeline); DORA (upper limit about 10 minutes); Google SWE ch. 23 (presubmit runs "only fast, reliable" tests, slow ones go post-submit) [named expert]
- Lint only the staged or changed files in a local hook. lint-staged README "Why" [named expert]; lefthook `{staged_files}` and glob filters; pre-commit (passes only staged files by default); two adopters [unverified]
- Run independent hooks in parallel. lefthook `parallel: true` ("Gives you more speed"); pre-commit runs a hook's files in parallel batches (`require_serial: false` default). Two adopters, no default [unverified]
- Cache pre-commit's environments in CI (`PRE_COMMIT_HOME` / `~/.cache/pre-commit`). pre-commit.com "Managing CI Caches" [standard or field body]
- Remove flaky checks from the blocking path; use hermetic tests where you can. Google SWE ch. 23 ("Why presubmit isn't enough", flaky tests, hermetic testing); DORA (fast, reliable feedback) [named expert]

## Banned-phrase gates over prose

- Keep the banned patterns in one rule file that every consumer reads, never copied into each check. Vale styles hold `existence` rules as a `tokens` list; textlint-rule-prh and textlint-rule-stop-words load the list from a path several repos can point at. vale.sh docs (existence rules); textlint-rule-prh README (`rulePaths`); textlint-rule-stop-words README (`words` from a file). Three adopters, no default [unverified]
- Ship each rule with example text it must catch, tested beside it. PostHog handbook, "Vale and prose linting" (add examples to `test/` with every rule) [named expert]
- Set a level on each rule, `error` being the one that fails the build. Spectro Cloud, "How we use Vale" (`level: error` per rule) [named expert]

## Co-change and staleness gates

- Run a co-change check (file A changed, the text describing it did not) on the change itself, never only on a timer. Google's `LINT.IfChange`/`LINT.ThenChange` runs at presubmit or review time on the change. Fuchsia "Presubmit checks"; ChromiumOS "Keep files in sync" guide. Two adopters, no default [unverified]
- In the Google family the finding is a non-blocking comment on the change that a human reviewer also sees. Fuchsia: "IfThisThenThat leaves _warnings_ and so does not block changelist submission". Fuchsia "Presubmit checks" [standard or field body]
- Open-source ports refuse by default and make warn mode opt-in: ebrevdo/ifttt-lint, simonepri/ifttt-lint, slnc/ifchange (`--warn`) and ifctc all exit non-zero in a hook or CI. Their READMEs [standard or field body]
- The escape for a change that needs no co-change is a commit-message footer with a reason slot, `NO_IFTTT=<reason>`. No source shows a tool that rejects an empty reason; the reason is for the reviewer. Fuchsia; ChromiumOS; simonepri/ifttt-lint. Three adopters, no default [unverified]
- A warning with no reviewer to see it is ignored: Google found developers ignore warnings, so a check is a build error or a code-review finding, never a log warning; blocking is kept for checks with near-zero false positives. Sadowski et al., "Lessons from Building Static Analysis Tools at Google", CACM 61(4) 2018; SWE at Google ch. 20 [named expert]
- The same check can be soft at review time and hard at the commit gate: Chromium's presubmit API warns on upload and errors on commit (`input_api.is_committing`). Chromium "Presubmit Scripts" [standard or field body]
- Doc freshness metadata (owner plus reviewed date) is the periodic exception: it emails a reminder after a period such as three months and blocks nothing. SWE at Google ch. 10 [named expert]

## Static-analysis findings ruled false

- Turn a check off where its effective false-positive rate passes 10%, until it is fixed; an effective false positive is a finding developers take no positive action on. Sadowski et al., "Lessons from Building Static Analysis Tools at Google", CACM 61(4) 2018; Sadowski et al., "Tricorder", ICSE 2015 (< 10% at code review) [named expert]
- False positives, and no cheap way to silence them, are the main reason developers stop using a static-analysis tool. Johnson et al., "Why Don't Software Developers Use Static Analysis Tools to Find Bugs?", ICSE 2013 [named expert]
- SonarQube Cloud's quality gate judges new code only ("Clean as You Code"). SonarQube Cloud docs, "Clean as You Code" and quality gates [standard or field body]
- SonarQube Cloud switches off a rule class for a project, optionally for a path pattern, under Administration > General Settings > Analysis scope > Issues > Ignore Issues on Multiple Criteria (rule-key pattern plus file-path pattern). Under automatic analysis `.sonarcloud.properties` takes only the scope keys, not `sonar.issue.ignore.multicriteria`. A single finding is closed by marking it False positive with a comment. SonarQube Cloud docs, "Automatic analysis" §Additional analysis configuration; "Advanced exclusions"; "Editing issues" [standard or field body]
