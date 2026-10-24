# Verification — the claims that must be checked before they are made

## Asserting that something is not implemented

**A negative from one file is evidence about that file, not about the system.**
Before writing "X is not built", grep the whole subsystem for the *behaviour* —
the output shape, the field name, the string a user would see — not the file the
spec names. Where a thin wrapper delegates, search the delegate. Then say what
you searched.

The same applies to calling a figure, term or card undefined (mantahostels#122, a
requirement reported unbuilt that was built one call away).

## Asserting that nothing of yours is still running

**`ps | grep` is not the check.** A background job's own completion
notification, and the session's shell counter, are the inventory; a hand-rolled
process search answers about the pattern you happened to write, and reports a
wedged job as absent. On 23 Aug 2026 a session told the founder "nothing of
mine is running" off a `ps | grep` while one of its own shells was still live
in the UI.

Kill by a pid you captured, never by a pattern: the Bash tool runs every
command as `/bin/bash -c '<command>'`, so `pgrep -f` and `pkill -f` match the
shell issuing them wherever the pattern matches the command's own text.
Under `-v` that inverts: the pattern selects every process it misses, so a
bracketed one puts the shell in; without `-f` the pattern is tested against
process names, and the shell's is `bash` (workflow-core#1842, workflow-core#1847).
`scripts/guard-self-match.sh` denies the `pkill` form and warns on the `pgrep`
one, and (mantahostels#2014) warns on `ps | grep <pattern>` too, each passing a
pattern that cannot match its own text (`'[n]ode'`, workflow-core#1782, workflow-core#1805) — the same
self-match, plus a wrinkle specific to
checking a `run_in_background` job: its harness task id is never in any
process's own command line, so grepping for that id finds nothing while the
job runs, and `grep -v grep` drops the true match too whenever the target's
own command line contains the word "grep" (a liveness-polling loop's usually
does).

**One class of leftover is answerable without a search**: a wait loop that
outlived its session. `npm run check:orphan-loops` names each one with its
`kill`, and runs at every session start, so a silent session start is itself the
assertion (mantahostels#2043). It sees orphans only — a loop your own shell still parents is
not covered by it.

## Asserting a figure from a pipeline

**Re-derive a summary claim from the source file before presenting it** — row
counts, membership checks, arithmetic reconciliation (does *n* sum to the
expected total?). Never restate an intermediate script's print statement or your
own earlier prose.

Surface a premise that turns out wrong rather than silently patching around
it.

**A Biome count taken without `--max-diagnostics=none` is a silent undercount.**
`biome lint` and `biome ci` cap output at 20 diagnostics by default and the
summary line counts only what was printed — one measured case reported 20
against 694 actual, 35x out. Tells: a count landing on exactly 20, or two runs
of the same command listing different files. Separately, `--only=<rule>`
bypasses any `overrides` block and forces the rule across every path, so a
scoped configuration measured with `--only` reports the unscoped count.

## Asserting that a config change is in force

**Load an edited config once, as part of the change** — run the tool it
configures, plus `node_modules/.bin/tsc --noEmit` where the config is
TypeScript. Verify the key against `node_modules/<pkg>/dist/**/*.d.ts` rather
than recalling the API.

A key copied from an older major version is silently ignored by the tool while
failing the build's type-check (mantahostels#641, which records the Vitest worker cap that
was never in force).

## Asserting that a checker passed

**Judge a `check-*` run by the outcome word it prints, never by its exit
status and never by scanning its output for "error".** Every checker built on
`runCheck` leads its summary line with one of `OK:` / `SKIP:` / `WARN:` /
`FAIL:` / `BROKEN:` (`scripts/lib/check.js:315-320`) — five outcomes over three
exit codes, so **three of the five are exit 0** and one of those three, `WARN`,
is *"real findings, deliberately not gating"* (`scripts/lib/check.js:54-60`).

- **`SKIP` is not `OK`.** It means the checker never looked, and it zeroes the
  finding count as it goes (`scripts/lib/check.js:309-311`), so it reads
  identically to a clean run. It fires on a routine absence:
  `check-ci-status.js` SKIPs whenever GitHub is unreachable.
- **A second routine absence, and the one that reads most like a pass: a gate
  whose INPUT this repo does not carry.** This core is forked, and a fork need
  not take every document the gates were written against — so
  `check-context-budget.js` drops a pool member the revision has no file for.
  **Absent is not unreadable**: a file that IS there and will not read or parse
  is still `BROKEN`, which is the distinction to check before reading it as a
  clean run (workflow-core#11).
- **A `guard-*` script's exit status carries nothing** — all of them always
  exit 0 and put the verdict in the hook's JSON payload
  (`docs/code-standards-base.md` §N5). Read the deny text, not the code.
- **The tier is a property of the invocation, not the script**, so never cache
  "this one gates". `--warn` demotes a real `FAIL` to an exit-0 `WARN`
  (`scripts/lib/check.js:269`) — `check-user-settings-drift.js` is
  warn-only in `.husky/pre-commit` and gating via `npm run check:settings` —
  and `--notify` forces exit 0 unconditionally, `BROKEN` included, while
  printing nothing at all on `OK` or `SKIP` (`scripts/lib/check.js:370`, `:380`).
  **So silence from a session-start hook distinguishes nothing**: it is as
  consistent with a checker that could not run as with one that ran clean.
- **A commit landing is not a verdict either.** `.husky/pre-commit` passes a
  `FAIL` whose fault is already in `HEAD`, printing an explanation and
  continuing, and its `npm run typecheck` gate is warn-only by design (mantahostels#1062).

`docs/agents/issue-tracker.md` rules the same thing for tracker commands
(mantahostels#1332).

## Asserting that an error identifies what you think

- **Node's `execFileSync`/`spawnSync` put the entire command line in
  `e.message`** — `Command failed: gh issue list --search "rate limit"`. A
  classifier that pattern-matches `e.message` is steerable by the call's own
  arguments: at mantahostels#164 (a `gh`-failure classifier deciding "unreachable → exit 0"
  against "broken → exit 2") a query containing `rate limit` or `GH_TOKEN` in
  its args would have passed as clean. Match on `e.stderr` and `e.code`
  (`ENOENT`, `ENOBUFS`). `e.message` is safe only for a thrown JS error with no
  stderr, and there take its **first** line — the reason leads and the stack
  follows; for a child's stderr take the **last**, since `gh` prints the reason
  under any warnings.
- **`git` exit 128 with `fatal: not a git repository` cannot tell a non-repo
  from a broken one.** Measured on git 2.43.0 at mantahostels#253 (a directory that exists
  but is not a repo), which records the other cases returning that same code and
  stderr — a `.git` file pointing at a gitdir that is gone among them.
  `rev-parse --is-inside-work-tree` adds no signal — it fails
  identically. Matching that string folds genuine breakage into a confident
  "no", the fail-closed direction a guard here may not take. Ask the filesystem
  instead: canonicalise the path (the walk is lexical, git resolves physical)
  and walk the ancestry for a `.git` entry — a directory for a normal repo, a
  file for a linked worktree or submodule. Implemented as `_gp_inside_any_repo`
  in `scripts/lib/guard-parse.sh`.

## Restating a constraint from an external source

**A sourced constraint is restated at the scope and the certainty the source
gave it — never broadened, narrowed, or silently resolved.** Quote the operative
clause; paraphrase is where the scope moves without anyone deciding to move it.
Where the source leaves a question open, restate it as open rather than taking
the reading that makes the decision easy.

Two failures, both from this repo's OTA-terms layer:

- **A clause cited from recall drifts to its neighbour** — mantahostels#93, the ticket that
  corrected this project's citation of one platform's price-comparison bar.
  Re-open the clause at the point of citing it, not once at the point of first
  reading it.
- **A permission read wider than the source grants it** — mantahostels#79, the ticket that
  ruled a generic affiliate approval does not license price comparison.

Check the constraint against the source text, never against an earlier
restatement of it — this file included.

## Asserting a confidence figure on a design option

**A `Confidence: 62% (55% - 70%)` line priced onto an option is a claim, and it
is checked like one.** Before writing the figure, open the source the option
turns on — the ruling, the measurement, the file it would change — or say in the
same line that it is priced on recall.

At mantahostels#1037 (the ticket that added the independence declaration to the
priced-options round) an option was priced at 55% (40% - 68%) without opening
mantahostels#102, the ruling that settled whether selection is a skill, a script or a
discipline — the single most relevant source, and one that said the opposite of
the assumption inside the price.

The band is where an unread source shows. Widen it, or say the question is
unknowable and why.

## Asserting that a guarantee is tested

**A mutation test proves nothing until you have proved it ran.**
`docs/agents/mutation-testing.md` carries the craft, in four failure classes: a
mutation that never landed (a no-op `perl -pi`, an `&` expanding to the whole
match, an empty-string mutant that shreds the file); a killing test that never
ran (a `-t` filter skipping it, a vacuous fixture, a missing `GITHUB_ACTIONS`,
stale `__pycache__`); a reversal that clobbers a neighbour; and an ordering no
mutation reaches (`/dev/full`, differential-fuzzing a guard against bash).
