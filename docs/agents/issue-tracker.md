# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Running `gh` at all — what this machine's `gh` cannot do

*This section stays in this file (mantahostels#716).*

<!-- rule:gh-cli-limits:begin -->
**Run `gh` in the foreground, and re-run an empty result once before believing it.** The zero-comment `--comments` read is one known cause, with `--json` as the substitute; the rest follow. The Bash tool's own timeout bounds a hang. **A hang seen again reopens #498.**

**The token is a fine-grained PAT with no `checks:read`, and that is not grantable** — `Checks` is a GitHub App permission, not offered to fine-grained PATs. So `gh pr checks <n>`, any `--json statusCheckRollup`, and `…/commits/<sha>/check-runs` all 403 permanently. **`gh run list --branch <branch>` is the working route** and `gh run view <id> --json jobs` with it — a 403 there has been a transient outage before now (mantahostels#641), so retry before concluding a scope was lost. `gh pr view <n> --json mergeStateStatus` also substitutes: `CLEAN` means mergeable and passing, `UNSTABLE` mergeable with failing checks. The token cannot read the billing counter but CAN PATCH repo settings (#2544; test: a no-op PATCH on the repo's current name). A classifier refusal of one goes to the founder, never another route. **It CAN re-run a workflow run** (mantahostels#3152) — `gh run rerun <id> --failed` exits 0 printing nothing, and the run reads `queued` with the failed job carrying a fresh `startedAt`. So a flake red on `main` is yours to clear, not the founder's. It spends none of the 3-a-day sweep budget, which counts `gh workflow run` fires alone. **Untested:** `gh run rerun` without `--failed`. **Another fault: `gh issue view <n> --comments` (gh 2.95.0) returns zero bytes at exit 0 on a zero-comment issue** (mantahostels#2134) — `gh issue view <n>` with no `--comments`, and `--comments` on an issue that has comments, both work. And `gh run list --commit <sha>` returns an **empty list even when completed runs for that sha exist** — never a wait-loop exit test.
<!-- rule:gh-cli-limits:end -->

**`docs/agents/guard-registry.md` §Conventions' push rule prescribes `gh run list --branch main --json …,headSha` and filtering `headSha` yourself; two traps make that spelling non-optional:** the empty `--commit` list above, and a run's own `status`, which can read `in_progress` with an empty `conclusion` for ~20 minutes after every one of its jobs finished. **Never write a wait-loop whose exit test is the run-level `status`;** poll `gh run view <id> --json jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion)"'` and exit when every job is `completed`. `jobs` exists only on `gh run view` — `gh run list --json jobs` exits 1 with `Unknown JSON field`.

## Relationship to the roadmap

`docs/reference-roadmap.html` is the sole authority for card state, phase, content and logs. GitHub Issues is the **working surface** — where a card's work is actually carried out.

**Workflow:** roadmap card → opened as a GitHub issue → `/wayfinder` → completion → roadmap updated.

**The roadmap lags the tracker by design, so absence from `reference-roadmap.html` means "not yet applied", never "not owned".** mantahostels#51 (the standing pass that applies settled decisions back onto the roadmap) holds decided-but-unapplied work in its open sub-issues, so skim those before opening any issue — and search the tracker in both states first, per §Where decisions get written below.

### Gating an issue: a date, a condition, or a close onto the card

<!-- rule:roadmap-gating:begin -->
GitHub Issues holds what is being worked on **now**; the roadmap is the backlog, taken when it makes sense. An issue gated on a distant *date* therefore **closes, with a `card:<card-id>` label applied naming the card that will fire it, and is re-filed when that card is taken** by querying `gh issue list --state closed --label card:<id>` (mantahostels#1048, mantahostels#3291, mantahostels#3320).

| The gate | What to do |
|---|---|
| A calendar date **within 14 days** | Keep the issue open, carrying `**Gated until:** YYYY-MM-DD — <why>`. `scripts/pick-next.js` holds it out of the shortlist until that date and prints it under GATED |
| A **data condition you can state in a sentence** | Keep the issue open, carrying `**Gated on:** <condition> — abandon if: <what makes the ticket not worth doing>`, and `— check: <command>` between the two where one command tests it. `scripts/pick-next.js` holds it out of the shortlist and prints the line verbatim under GATED, evaluating nothing (mantahostels#1329, mantahostels#1330). Two routes judge it (#2279): `/pick-next` runs `scripts/check-gates.js --issue <n>` on each GATED row; the refill loop sweeps every gate on its own cadence and launches `/triage <n>` on a changed reading. On met, the judge comments the evidence and strips the marker; no exit code is a verdict (mantahostels#1332) |
| A date **beyond 14 days**, or a gate you cannot state as a condition at all | Close it, having first applied the `card:<card-id>` label naming the card that will fire it |

**The founder typing a `/`-command is never a condition** — a dispatched session types it too, so the gate only stops dispatch. Relabel to that command's `takes:` value instead; `scripts/check-issue-labels.js` reports the shape as COMMAND-GATE (#411).

**Each gate line carries `**Gate basis:** <the data that sets the date or window, and why nothing sooner fits it>` on its own line directly beneath it** — a window inside a condition ("4 weeks of data") included, and on a gate added to an existing issue as much as a new one. **A wait written as prose — `after a week live`, `two weeks after`, `no earlier than` — owes the same line**. The window is the shortest the data defends. **Enforced at write time** (#672, #823): the create guard, `file-issue.js` and `issue-body.js`'s command line refuse a body adding either with no basis, or adding a window — a count and a unit, an `abandon if:` clause's included — that its basis does not name. It checks the basis names each window, never that the basis holds up; the REST and GraphQL creates pass it unjudged. `file-issue.js` and `issue-body.js` print this rule whenever a write adds a gate line. A missing or empty basis on an existing body still gates; `scripts/check-issue-labels.js` reports it as NO-GATE-BASIS (#577).
<!-- rule:roadmap-gating:end -->

A data condition keeps the issue open whether or not a roadmap card exists.

**No single command tests your condition? That is still the middle row.** Write the condition without a `check:` and leave the reader to judge it — never a guessed date.

**`check:` names a command that prints a reading, never one whose exit code is a verdict** (mantahostels#1332, which ruled what happens when a check cannot run). Where the command is gone, crashes or prints nothing, **judge the condition by whatever other means are available, then repair or delete the dead segment before you finish** — a broken command is never itself the blocker, in either direction.

**`npm run check:gates` runs every open condition's `check:` command and prints the reading, and it is what makes a met condition noticeable at all** (mantahostels#2656). `scripts/pick-next.js` excludes a conditioned issue before any session can take it, so the judgement the middle row asks for has no other moment at which it happens. It runs in the `npm run status` fan-out and nowhere automatic; **it decides nothing**, so a row saying `DEAD`, `NO-OUTPUT`, `OVER-BUDGET` or `NOT-A-COMMAND` is the repair above, and a reading is still yours to judge against the condition.

**Never write the literal text `— check: ` or `— abandon if: ` inside the condition or the command itself** — a second occurrence is reported malformed, and even one, in the marker's own separator shape, still silently mis-splits (mantahostels#1435, which found no quoting syntax worth inventing for it).

Fourteen days governs dated gates alone — a judgement, not a measurement. A data condition rots by being met rather than by a date arriving, so it has no distance to compare against. `abandon if:` is the only thing that ever retires one.

**One gate line per issue.** An issue carrying both gates nothing and is reported, matching how `scripts/lib/issue-gate.js` fails open on an unreadable date. Migrating a dated ticket to a condition deletes the date line rather than adding beside it.

<!-- rule:blocked-ticket-gate:begin -->
**A ticket you find not ready gets its gate written before you end** (#2309): a native blocked-by edge to the issue whose work it waits on, filed unassigned first if missing; else a `**Gated on:**` line with its `**Gate basis:**`, the table's middle row. A comment opening `**Blocked` or `**Refused attempt`, or `waiting:external`, gates nothing, so the next launch takes it again.
<!-- rule:blocked-ticket-gate:end -->

`scripts/check-issue-labels.js` reports an open issue whose latest comment opens `**Blocked` or `**Refused attempt` and that has no open blocker and no gate line as PROSE-BLOCKED (#2309, ruled at #2212; #3111).

**Never write a closed issue's trigger onto its card as prose** — the card stays the bare action guide (mantahostels#3291, mantahostels#3320).

### Issue titles: `<card-id> — <title>`

<!-- rule:issue-title-card-id:begin -->
An issue that carries a roadmap card **must** be titled with the card id, an em dash, then the title — e.g. `id-match — Build the hostel ID-matching layer`. `/card-close` parses the prefix to find which card to mark `done`, and refuses to guess if it doesn't resolve to exactly one card — so an issue opened without the prefix cannot be closed by that command.
<!-- rule:issue-title-card-id:end -->

### Closing an issue

<!-- rule:card-close-route:begin -->
Close via **`/card-close <issue-number>`**, which closes the issue and runs the `roadmap-edit` pipeline in one invocation. Closing an issue by any other route — `gh issue close`, the GitHub UI, a merge keyword — **leaves the roadmap stale**, and must be followed immediately by a roadmap update through the `roadmap-edit` skill.
<!-- rule:card-close-route:end -->

A hand `gh issue close` on a card's own issue is **denied** by `scripts/guard-issue-close.js` (mantahostels#220), at `PreToolUse`.

`scripts/check-issue-card-drift.js` remains the backstop, reporting closed-issue/card-state disagreement in both directions after the fact; its scoping rules are in that script's header. **It only ever reports.** A drift entry is a prompt to decide the real state and record it through `roadmap-edit`, never a batch to auto-apply.

### Every close says what is still outstanding

<!-- rule:close-outstanding-line:begin -->
**Every close says what is still outstanding**, on an `**Outstanding:**` line in the close's own `--comment` or else the issue's newest comment: the bare word `none`, or `#N (what is left)` items each citing an OPEN issue other than this one. `scripts/guard-issue-close.js` and `resolve-ticket.js` (mantahostels#185, #984) refuse anything else. `--reason "not planned"` is exempt. A close through the GitHub UI or `gh api --method PATCH` is not seen, and a `--comment` holding a `$` or backtick expansion is not judged: the guard allows that close and records it unchecked (#990).

<!-- rule:close-outstanding-line:end -->

The findings that feed that line come from `/code-review`: every finding is **fixed** (name the commit), **ticketed** (name the open issue), or **declined** (say why).

<!-- rule:commit-closes-keyword:begin -->
**Never write `Closes`/`Fixes`/`Resolves #n` in a commit message.** GitHub closes the issue server-side the moment the commit is pushed, so `guard-issue-close.js` — a hook on `gh issue close` — never fires, and the issue closes with no resolution comment and no `**Outstanding:**` line. Where that issue stood for more than one fault, every fault but the one being fixed goes untracked with nothing recording it (#118). Write `Refs #n` instead, and where the close is genuinely wanted make it explicitly afterwards — `gh issue close <n> --comment "…"` — so it carries the line. **Enforced** (mantahostels#2592, #129, #138), at three seams, all matching all nine of GitHub's keywords in any case and all three reference spellings — the one pattern is `scripts/lib/closing-keyword.js`. `scripts/guard-commit-form.js` denies the Bash-tool call, reading `-m`/`--message` values alone. `.husky/prepare-commit-msg` then scans the finished message file, which covers `-F <file>`, a `-c`/`-C` reuse, **a commit from the founder's own terminal** and a `--no-verify` one. `.husky/commit-msg` covers the last route, a message typed into `$EDITOR`: `prepare-commit-msg` runs before the editor opens and is handed an empty file (#138). **Four residuals.** `--no-verify` skips `commit-msg`, so the editor route survives it. Both hooks stand down on a rebase or cherry-pick replay, so a pre-#129 commit still replays — while a `--amend` or `--fixup` of one is refused, a founder-terminal case only. The scanner drops a `Revert "…"` first line, so reverting such a commit re-closes its issue, and any first line beginning `Revert "` passes whatever follows it. And `git revert` never reaches `commit-msg`, so a keyword typed into a revert's body in the editor is seen by neither seam. Once such a commit exists `git commit --amend` is denied in the shared tree (mantahostels#2540), so let the auto-close land and post the resolution comment onto the already-closed issue by hand.
<!-- rule:commit-closes-keyword:end -->

### Every close that names a commit says whether it can be undone

A resolution comment naming a commit sha carries a `**Door:**` line (#895, ruled at #881), in one of two shapes:

- `**Door:** two-way — <what undoing it takes>`
- `**Door:** one-way — <which entry below>; <what undoing it takes, or that it cannot be undone>`

The undo step is the content: a bare label passes the check and still fails the rule. The session that did the work calls it, against the list below — never Jev, never the `/code-review` Spec reviewer. Term: `GLOSSARY.md` **Door**.

**The one-way list.** Add an entry when a close finds a case none of these covers.

1. Shipping a plugin version or release that adopters pull.
2. Anything sent outside this repository: an email, a social post, a payment, a vendor call carrying our data, a push to another repository.
3. Deleting what git does not hold: an issue, a remote branch, a repository, gitignored data, a GitHub setting.
4. Rewriting published history: a force-push.

**Where the line is one-way, or you cannot state the undo step, name it in your reply to the founder that same session.**

**Enforced** (#895): `scripts/resolve-ticket.js` refuses a comment naming a commit sha with no `**Door:**` line reading `two-way` or `one-way`. Any sha counts, one cited only for reference included, so such a decision close carries the line too. A `--reason "not planned"` close is exempt. A hand `gh issue close`, the GitHub UI and `gh api` are not checked.

### Closing an issue with acceptance criteria — tick them first
<!-- rule:ticket-criteria-unticked:begin -->
**An issue with acceptance criteria, whatever its labels, closes with them
worked, never batch-ticked to clear a report.** Re-read the body first (`node scripts/issue-body.js show
<n>`), and tick only what this session verified, one call each: `tick <n>
--match "<distinctive words from that criterion>"`. Anything unverified or
deliberately dropped stays **unticked**, annotated `annotate <n> --match "<the
criterion>" --text "**waived:** <why>"`.
<!-- rule:ticket-criteria-unticked:end -->


Two refusals to know: `tick` refuses a match that hits no checkbox, and an `annotate` marker with no reason still fails.

`/implement` is handed this whole section, but only the `**waived:**` annotation is repeated at the review, in `scripts/guard-dispatch.js`'s `guard-review-rules` core's deviations rule (mantahostels#3451) — that is where a criterion it deliberately dropped goes, not the `**Deviations:**` comment, which would record it twice (mantahostels#1242). Nothing makes it re-read, tick or close on its own.

**Enforced** (#1640): `scripts/resolve-ticket.js` and `scripts/guard-issue-close.js` refuse a completed close over any criterion neither ticked nor waived, both reading the body through `scripts/lib/ticket-criteria.js`. A `--reason "not planned"` close passes. The GitHub UI and `gh api` are not checked.

`scripts/check-ticket-criteria.js` reports closed issues with unticked criteria — daily from the session-start launcher (`scripts/repo-checks.js`), on demand with `npm run check:tickets`. Reports only.

### A `/wayfinder` research subagent that stalls

A mandatory site of `docs/agents/guard-registry.md` §Subagent dispatch: watch the
`.claude/tmp/research-<name>.md` the agent is already writing (§Research
artefacts below) with a backgrounded `node scripts/watch-artefact.js <path>
120`. Name it on an `Artefact:` line of its own and tell it to append
findings as they land. Without that line `scripts/lib/dispatch-rewrite.js`
supplies one under `.claude/tmp/agents/`, not the scratch path the fallback
below carries forward (#515). When the agent's completion notification
arrives, `TaskStop` its watcher first.

**Fallback, on `STALLED` or `MISSING`: re-dispatch once**, with the same
context pointer and scratch path, carrying the partial note forward. On a
second stall, leave the ticket **open and unassigned** with a comment recording
the stall, so the frontier query surfaces it again for a later session.

### When a `/wayfinder` session reaches the wind-up notice (#53, #63, #1178)

The ceiling guard's wind-up notice (`docs/effort-guide.md`) tells a session
past the band to finish the unit in flight, even if a compaction fires, start
no new one, and end (#1178 Q1 (A)). `/wayfinder`'s own ticket types say what the unit in flight is:

- **A grilling or prototype ticket is HITL** — it ends only **between
  rounds**, and only after posting any answers it has already received.
  Before a session ends on `needs input:` with a question round, it posts the
  round as a comment on the ticket that carries it, and that ticket stands in
  its `waits on you:` block. **Enforced** in background jobs (#988):
  `scripts/guard-inventory.js` refuses the ending where no cited issue holds
  the round among its newest five comments.
- **A research or task ticket is AFK**: the ticket is the unit, finished in
  place.
- **A charting run treats the map itself as its ticket**, finishing whatever
  the four charting-done conditions still owe — map body, child issues, wired
  and read-back blocking edges, every `wayfinder:research` ticket resolved and
  closed (`scripts/inject-tracker-docs.sh`'s injected `/wayfinder` reminder,
  "A charting run is DONE when four things are true").

### Research artefacts: drafted in `.claude/tmp/`, cut, then posted on the issue

**This binds every research artefact, however it was dispatched** — a `wayfinder:research` ticket, an ad-hoc `Agent` call, a bare `research` skill invocation. Its first half binds at **dispatch** time, so meeting it only when closing a ticket is already too late.

<!-- rule:research-artefact-scratch:begin -->
**At dispatch, the subagent never writes into `docs/research/`.** Paste this into its prompt verbatim:

> Artefact: .claude/tmp/research-<name>.md
>
> Write your findings to `.claude/tmp/research-<name>.md`, appending each the moment it lands rather than holding them back for your final report. Do NOT write anywhere under `docs/`, and do NOT commit anything. Report the absolute path of the file back to me when you finish. Write the artefact in ASD-STE100 Simplified Technical English.

`.claude/tmp/` is this repo's one sanctioned **in-repo** scratch directory (mantahostels#2089, the founder ruling that chose it over an out-of-repo path). `scripts/guard-dispatch.js` refuses a file a session writes straight into the `$CLAUDE_JOB_DIR/tmp` the background-job preamble points at, and warns once on any deeper job-dir write; both carry the whole rule (mantahostels#2406, #1139; `docs/agents/rules/job-dir-scratch.txt`). **It binds the scratch YOU choose a path for, not a script writing its own job-dir path** — `scripts/bg-run.sh` and `scripts/issue-body.js` both do that deliberately, and a hook on your own tool call cannot see either. It is gitignored, so a scratch file there carries no doc-map §A row and nothing the subagent does can freeze it. **Hand an absolute path instead when the subagent works in a throwaway worktree**: a repo-relative path resolves against *its* cwd, so the file lands inside that worktree and the parent watching the artefact never sees it grow. `scripts/inject-tracker-docs.sh` hands this clause to every `/wayfinder` session; on any other dispatch route, paste it yourself.

**Size a reading agent's job to its context window:** split a large source family across agents, and have each save fetched text to disk and search it rather than read it whole (#1789).

<!-- rule:research-artefact-scratch:end -->

**At posting — the dispatching session, never the subagent:**

1. Call the Skill tool with "concision-pass" over the scratch file and apply the cuts there, **before you post it**. A subagent judging prose it just wrote is not a pass.
2. Post the artefact on its issue as a comment (`gh issue comment <n> --body-file <scratch file>`), split across comments where it passes GitHub's 65,536-character limit, and link that comment from the resolution.
3. **Where a figure from the artefact is baked into a build** — a guard's printed output, a gate threshold, a value a script reads — land whatever makes that figure refreshable: its instrument, its dataset, or both. A dataset makes the **published** figure recheckable; an instrument makes a **fresh** figure computable against a corpus that has since moved — land both where the corpus keeps changing. An instrument holding Python meets the pre-commit ruff gate: fix its findings — never delete it to pass (#1022). `ruffExclude` in `.claude/workflow-core.json` is for vendored or third-party code alone, which is not this repo's to fix: editing it forks it from upstream (#1463). The trigger is observable at ticket time, not judgement: the moment a `takes:implement` ticket is written that consumes a figure from the artefact, that ticket also lands whatever the figure needs. A figure that lives only in prose cites the issue comment. Precedent, both of which landed the dataset and not the instrument: `docs/data/git-spawn-census-2026-08-30.csv` and `docs/data/suite-file-timings-2026-08-30.csv`.

Don't move this rule into the skill: `wayfinder` is vendored, so hand-edits are lost on re-vendor.

<!-- rule:research-in-tree:begin -->
**Research never lands in `docs/research/`**: the repo holds no dated research snapshot (#2162). Post the artefact on its issue instead, and leave the file out of the commit. **A file still in `docs/research/` is deleted once a decision has used it**, and the resolving issue gets a comment linking it at a fixed commit (`https://github.com/<owner>/<repo>/blob/<sha>/docs/research/<name>.md`); a link to it elsewhere is repointed to that URL or cut (#2335).
<!-- rule:research-in-tree:end -->

**Enforced** (#2356): `scripts/check-research-added.js` in `.husky/pre-commit` refuses a commit adding a file under `docs/research/`, a rename or copy into it included, and prints the rule (`rule:research-in-tree`).

### Where decisions get written

<!-- rule:decisions-search-first:begin -->
Both surfaces, at different densities:

- **The GitHub issue** carries the full reasoning — options considered, what was rejected and why, the working.
- **The roadmap card's done-log** carries a **condensed summary only**. If a log entry needs paragraphs, it belongs on the issue with a pointer from the log.

**So read them.** A ruling recorded only on a **closed** issue still binds until re-ruled. Whether to recommend re-ruling is a merit question: re-check the reasons it rested on rather than inheriting them (#1457). Ledger items (`C9`, `C45`…) exist nowhere else. Before writing that a figure, term or card is unsourced, undefined or undesigned, run `gh issue list --repo <tracker> --state all --search "<term>"` for every tracker the `corpus` key of `.claude/workflow-core.json` lists, and read the resolution comments on every hit.
<!-- rule:decisions-search-first:end -->

## Editing an issue body — never `gh issue edit --body` directly

<!-- rule:issue-body-raw-write:begin -->
**Every issue-body edit goes through `scripts/issue-body.js`.** Run it with no arguments for the subcommands and their flags.
<!-- rule:issue-body-raw-write:end -->

```
node scripts/issue-body.js show           <n>
node scripts/issue-body.js append-section <n> --heading "Decisions so far" --text "- mantahostels#131 — …"
node scripts/issue-body.js append         <n> --text "…"          # or --file <f>
node scripts/issue-body.js tick           <n> --match "…"         # - [ ] → - [x]
node scripts/issue-body.js annotate       <n> --match "…" --text "…"
node scripts/issue-body.js delete-lines   <n> --match "…"
```

It fetches, applies the change, writes, then **re-fetches to confirm the change is actually there** — and where a parallel session overwrote you in the window, it re-applies your change onto *their* body instead of re-uploading your stale one.

<!-- rule:issue-body-success-signal:begin -->
**Read the exit code: 0 done or already done, 2 a refusal that wrote nothing** (usage, a non-idempotent transform, `append-section`'s missing heading), **1 anything else** — a `gh` failure, a give-up, a missing Decisions section, or a landed write since undone, its message naming the rescue file. **Run one subcommand per Bash call** — chaining several with `;` loses all but the first, silently. `append-section` takes several lines in one write (`--file <f>`, #1019) but refuses a `## <heading>` section that does not **already exist**. For a multi-paragraph addition or a new section, use `append <n> --file <f>` with the `## Heading` as the file's first line.
<!-- rule:issue-body-success-signal:end -->

**Only idempotent changes are safe:** each command above is a no-op when its change is already present, so re-applying it onto a rival's body adds your entry without duplicating it. A transform that fails that test is rejected before anything is written. The one exception is `replace <n> --file <f>`, a whole-body rewrite: it cannot be re-applied, so it refuses on divergence rather than retrying and leaves the other session's version for you to reconcile by hand. It also refuses outright on an empty or whitespace-only `--file`, with no escape (mantahostels#1579).

`scripts/guard-issue-body.js` denies the raw form at `PreToolUse` (mantahostels#132), including `gh api --method PATCH …/issues/<n> -f body=…`. Where that PATCH hides its fields — a fully quoted `-f "body=…"`, or `--input` — it warns instead of denying, so a warn there still needs your judgement. It denies `gh api graphql` too (mantahostels#284), where the query carries a `body:` inside `updateIssue`'s own arguments — whitespace ignored, since GraphQL ignores it. A `body` selected back in the response is a read, not a write, and still runs. Where the guard cannot see the query it warns instead: `-F query=@file`, `--input`, a variable, a command substitution, or an input object passed whole as one variable — a warn there is expected, not a near miss (mantahostels#284).

**Still fine to run directly:** `gh issue create --body`, which writes a body that does not exist yet — though the create-guard has its own reason to prefer `--body-file -`, in `docs/agents/triage-labels.md` §`takes:` — and `gh issue edit --add-assignee` / `--add-label` / any flag that is not `--body`/`--body-file`, which change a field server-side without downloading the body.

**Post a comment from a file, never from a `--body` string.** `--body` goes through bash, so every backtick pair in it is command substitution — including inside a ``` fence, which bash cannot see as markdown. The token is replaced by the command's empty stdout and the comment posts looking fine, minus that word; only stderr betrays it, as a `command not found`. `--body-file <f>` runs no shell. The flag spelling differs by command: `gh issue comment` and `gh issue create` take `--body-file`, while fixing a posted comment in place takes `gh api --method PATCH repos/<o>/<r>/issues/comments/<id> -F "body=@<file>"` — that endpoint is a comment, not an issue body, so `guard-issue-body.js` does not block it.

<!-- rule:gh-job-dir-unreadable:begin -->
**`gh` reads a `$CLAUDE_JOB_DIR` path fine** (mantahostels#2688), piped `--body-file -` included. The real hazard is unrelated to `gh`: **`$CLAUDE_JOB_DIR` can fail to resolve** (mantahostels#2088), breaking the path before any tool opens it. Use `.claude/tmp/` regardless — `docs/agents/rules/job-dir-scratch.txt`.
<!-- rule:gh-job-dir-unreadable:end -->

**It is not an absolute guarantee.** Sessions on this machine serialise through a local lock, but a writer outside it — your own terminal, another machine, CI — can still overwrite you in the gap between your write and your re-read, and you would be told the write succeeded. **If a body is clobbered, the lost text is recoverable:** GraphQL `Issue.userContentEdits` holds every past body in full (mantahostels#128) — **but not in edit order** (mantahostels#1579, which found `last:1` returning the *oldest* node): sort by `editedAt` before taking the latest one.

**And it is detected, daily.** `scripts/check-clobbered-bodies.js` (`npm run check:clobbers`, daily over a widening window in `scripts/repo-checks.js`) reads that same revision history. It keys off a **stale base** — everything one revision added is gone from the next, while essentially all of what preceded it survives — not off a shrink (mantahostels#141; `scripts/check-clobbered-bodies.js`'s header owns the figures, and corrects the transition count quoted on mantahostels#141 itself).

**A report here is a real loss, not a formatting complaint** (mantahostels#141). It self-suppresses once the text is back in the live body, so a finding that persists is still broken. Recover from the revision immediately before the timestamp it names, judge whether the lost ruling still holds, and re-apply through `scripts/issue-body.js`.

## Citing another issue

<!-- rule:citation-number-first:begin -->
Number before title, always — issue bodies, comments, `docs/` files. The number is the only token that resolves in GitHub search or `gh issue view`.
<!-- rule:citation-number-first:end -->

Overrides `.agents/skills/to-tickets/SKILL.md`'s "numbers/titles" (vendored, hash-locked, uncorrectable in place). GitHub's own **Blocked by** panel puts the title first; that is its rendering of the native dependency and no setting changes it.

`scripts/check-issue-citations.js` reports both faults — daily from the session-start launcher (`scripts/repo-checks.js`), on demand with `npm run check:citations`. Reports only.

<!-- rule:citation-inferred-number:begin -->
**Never cite a number you inferred — read it back from the create call's own output.** Parallel sessions consume numbers constantly, so `gh issue create` does not hand back the next one after the last you saw — the number you guessed is typically live, and another session's. This bites twice. Once on the follow-up `sub_issues`, label or `debt own` call, which must use the captured number. And once on **prose written before the create**, such as a resolution comment's `**Outstanding:**` line. **Create the tickets first, read their numbers, then write any prose that cites them.** A sub-issue link made under the wrong parent is undone with `gh api --method DELETE repos/<o>/<r>/issues/<parent>/sub_issue -F sub_issue_id=<child-db-id>`.
<!-- rule:citation-inferred-number:end -->

## Citing a commit in an issue

- Give the subject line alongside the hash. Work lands direct on `main` and gets rebased, so hashes written into comments go dead.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_ When `yes`, PRs run the same labels and states as issues via the `gh pr` equivalents, filtering `gh pr list --json …,authorAssociation` to `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE` to drop your own.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with `node scripts/file-issue.js` — **Placing a new issue** above.

Add the `kind:` label — `kind:spec` for a spec/PRD, `kind:ticket` for each ticket broken out of one. The vendored skills have no concept of this axis. **Do not apply the triage-state label the skill names**; translate it through the table at the top of `docs/agents/triage-labels.md`, which maps each vendored role onto a `takes:` value or a close. That file also carries when a spec's own `takes:` value moves.

**Never prepend the `> *This was generated by AI during triage.*` disclaimer `.agents/skills/triage/SKILL.md` calls for** (founder ruling on #606). No script reads or enforces it, so dropping it needs no declared vendored-skill edit.

<!-- rule:spec-only-contract:begin -->
**The spec is the only contract between planning and building** (founder ruling on #580, recorded at #606). `/to-tickets` reads the spec alone — body and comments — never the map or the brief, and never widens that reach: a spec that needs something from them is defective and goes back to `/to-spec`. So a spec carries decisions and chosen values, scope and out-of-scope lines, constraints with the reason where it limits the build, founder rulings, and links to ruling tickets for audit; never deliberation, rejected options (except as out-of-scope lines), session logs or process notes. A ruling or amendment after publication goes into the spec **body** (§Editing an issue body), never a comment. A spec filed under a `kind:brief` then goes up to its map: `rule:wayfinder-ops-shapes`, the many-destination branch.
<!-- rule:spec-only-contract:end -->

Blocking edges and parent links use GitHub's **native** sub-issue and dependency endpoints, never a text `Blocked by:` line — `/to-tickets` falls back to text only where a tracker lacks them, and GitHub doesn't. Commands and the stale-field trap are under **Wayfinding operations** below; they are not wayfinder-specific.

**Wire the edge as well as stating the order.** Where one ticket genuinely gates another, saying so in prose settles nothing a query can read — add the native `blocked_by` edge in the same session. The same holds on the roadmap, where the ordering lives in a card's `needs` (mantahostels#1618).

## Placing a new issue — decide the parent at creation

<!-- rule:issue-parent-unplaced:begin -->
An issue with no parent sits outside every map, so `/wayfinder`'s frontier query never offers it and the work it describes is never scheduled. Every issue created mid-session is placed before anything else: **file it with `node scripts/file-issue.js`** (#533), which creates, labels and links in one call. Working issue A, a new issue B is one of three things:

- **Caused by A** — split out of it, or surfaced while implementing it → sub-issue of A.
- **Peer work A's own parent owns**, not caused by A → give it that same parent.
- **A roadmap card** (`<card-id> — …` title), **or cross-cutting work with no single originator** → standalone; `--standalone` writes that in the body.

**A sub-issue holds its parent open**, so caused-by work ruled not to hold its originator is a peer or standalone, never a child — one the parent's own blockers wait on is a loop none of them can close (#495; `node scripts/check-issue-cycles.js` reports one).
<!-- rule:issue-parent-unplaced:end -->

**Prose is not placement.** An issue that names its origin in its own opening line — "Split out of mantahostels#63", "Parent map: mantahostels#40" — is still unplaced until it is linked. `scripts/place-new-issue.sh` (a `PostToolUse` hook on a hand `gh issue create`) asks at creation; `scripts/check-issue-orphans.js` (`npm run check:orphans`, daily in `scripts/repo-checks.js`) reports the ones that got away. Report-only, like the checks above: the phrase names a candidate parent, not a verified one.

**`POST /issues/<parent>/sub_issues` refuses at both sub-issue caps** — 422 *"You can't add more than 7 layers of sub-issues"* and 422 *"Parent cannot have more than 100 sub-issues"*; the remedies are under **Two dependency graphs** below. Taking the peer remedy, say in the body why it is a peer. Taking the archival container, run `node scripts/archive-closed-children.js <map>` (#92) — it creates the container **unparented**, moves the closed children in with `replace_parent=true`, links the container under the map **last** (a map at 100 cannot take it as its 101st child), and closes it. It is idempotent: a run with nothing newly closed does nothing, and a later run reuses the same container rather than making a second one. **The two caps interact:** the container adds a layer, so a child whose own subtree already reaches 7 layers stays a direct child — the script hits this on a 422, never walking subtree depth to pre-empt it. It does not chain a second container should one itself reach 100 children (#76). The container needs no `wayfinder:<type>` — `check-issue-labels.js` scans open issues only, and it is closed at once. `scripts/check-open-maps.js` warns at 90 sub-issues, naming this script.

**Link a child with `scripts/link-sub-issue.sh <parent> <child>`** (mantahostels#1150), which encodes the traps of the raw call — its own header names them — verifies the link from the parent side and never re-POSTs on the 422. Reach for the raw call only when it refuses.

**Read parentage from `parent_issue_url`** on the issue payload; there is no `.parent` field. Never rebuild it by walking every issue's `/sub_issues` — one call per issue, and it defaults to `per_page=30`, which silently truncates.

## Claiming — the issue you are working now, and only that one

<!-- rule:issue-created-assigned:begin -->
**An issue you file for later is created unassigned.** `--assignee @me` on a
create belongs only where the session works what it creates — `/to-spec`'s
spec, not a `/to-tickets` batch or a spun-off ticket it is not working.
Claiming unstarted work hides it from `/wayfinder`'s frontier (mantahostels#270,
mantahostels#702). Posting a question round on an issue is working it: claim it then (#1066).
<!-- rule:issue-created-assigned:end -->

<!-- rule:issue-claim-scope:begin -->
**Claim the issue you are working right now, and only that one, with `node
scripts/claim-issue.js <n>`** as your first write on it. It refuses a live
holder, records the arbiter claim and assigns you (#530). Never unassign on close.

**A hand spelling owes that record itself.** `scripts/record-issue-claim.js` makes
it off exactly `gh issue edit <n> --add-assignee @me` through the Bash tool; the
web UI, any other script, `gh api`, `--repo`, a shell-variable number or a login
in place of `@me` needs `node scripts/session-arbiter.js claim-issue <n>`.
<!-- rule:issue-claim-scope:end -->

**A create-time assignment goes through `file-issue.js --assign-self`**, which takes `claim-issue.js`'s path — `/to-spec`, on the spec it publishes. A `wayfinder:map` filed under a session id takes that path without the flag (#2314). A raw `gh issue create --assignee @me` is a seventh manual route, owing `node scripts/session-arbiter.js claim-issue <n>` by hand. The assignee is, after close, the only record of who did the work.

**The release at the close is made for you too**: `node scripts/resolve-ticket.js` releases the claim it closes (#534), and `scripts/release-issue-claim.js` drops it off a hand `gh issue close <n>` through the Bash tool (mantahostels#706). A close made by a session that never claimed the issue drops nothing. The same seven manual routes apply to the release — call `node scripts/session-arbiter.js release-issue <n>` by hand wherever the close bypassed a literal `gh issue close <n>` through the Bash tool.

**The loop holds an unassigned ticket under a claimed map.** `/wayfinder`'s charting step fires research subagents at tickets it has just filed without claiming them, its one-ticket-per-session limit exempting research tickets. So the charting session holds the map instead: `file-issue.js` claims the `wayfinder:map` it files (#2314), and `scripts/pick-next.js` and the dispatch gate, `scripts/check-duplicate-dispatch.js`, refuse a ticket while a live session holds an arbiter claim on it or on its parent map, naming the holder (#2310). Once the holder ends, they offer its children again. A spec's claim holds nothing: its children are for others to take. **What the gate cannot see**: a session working a ticket it neither claimed nor filed under a map it holds; and the frontier query, `scripts/wayfinder-frontier.js`, reads no parent claim, so a held map's children stay on it. Before starting a wayfinder ticket by hand, check `git worktree list` and look in `claude agents --json` for a live session whose `.name` names the ticket **or the ticket that surfaced it** — the parent question is what a title carries; it never names the child. `SendMessage` is denied in `~/.claude/settings.json`, so there is no asking the neighbour its intent — **a config choice, not a capability limit**, and one to argue on its merits at mantahostels#1694 rather than restate as impossibility: work only what its draft is demonstrably missing, in your own scratch directory, and re-read the issue state before writing anything to the tracker. Never write into another session's worktree.

**The assignee alone does not decide.** Both readers exclude an assigned issue only where the arbiter holds a matching claim whose session is live (mantahostels#633): `scripts/pick-next.js` (mantahostels#645), and the frontier query under **Wayfinding operations** below (mantahostels#702), through `scripts/wayfinder-frontier.js`. **An assignment nobody records stays in every shortlist and on the frontier** — deliberate, per mantahostels#633.

Unenforceable: an assignment is one `gh` call, identical whichever issue the session is really working. `scripts/check-stale-claims.js` (`npm run check:claims`, daily in `scripts/repo-checks.js`) is the backstop — it reports an open issue assigned over 14 days ago with no comment or commit since, at WARN. It never unassigns: a claim held across a slow decision looks the same from the timeline as an abandoned one, so a person decides.

## Session naming

Six commands rename the session after the work they were opened on, via `scripts/name-issue-session.sh` on `UserPromptSubmit` and `SessionStart` — nothing to do. Name shapes, argument parsing and the hook's residuals are in that script's header.

## Producer/consumer contract — every structured field needs a reader

Every structured field written into the tracker needs a named reader — the field/producer/consumer table is `docs/agents/tracker-fields.md`. When a skill starts writing a new field, add its row and name the consumer; if none exists, write one or stop emitting the field.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number>` for the body and `gh issue view <number> --json comments` for the comments, never `--comments` (`rule:gh-cli-limits`).

## Wayfinding operations

Used by `/wayfinder`. **The map is the roadmap card's own GitHub issue** — not a separate map issue. `/wayfinder` adds the `wayfinder:map` label to the existing card issue and appends the Destination / Notes / Decisions so far / Not yet specified / Out of scope sections to its body.

<!-- rule:wayfinder-ops-shapes:begin -->
- **Map**: the card's existing issue, labelled `wayfinder:map`, holding the Destination / Notes / Decisions so far / Not yet specified / Out of scope body. **Fog or ticket?** The test is whether you can state the question precisely now, not whether you can answer it: a sharp question is a ticket even while blocked, and one you cannot yet phrase that sharply goes under *Not yet specified*.
- **Child ticket**: an issue linked to the card issue as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` (`gh api repos/<owner>/<repo>/issues/<n> --jq .id` for the id — see `rule:dependency-edge-false-success` under **Two dependency graphs** below for the false-success traps on this call). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `node scripts/wayfinder-frontier.js --map <map>` — one call, and the whole query (mantahostels#1145). It resolves the map's open children, drops any carrying no `wayfinder:` label — a `kind:spec`, a `kind:brief`, an untyped child — naming each on stderr (#579; these drop notes are not warnings), reads each remaining one's blockers from the canonical list, drops the blocked, and drops an assigned one only where a *still-running* session holds an arbiter claim on it; what is left prints as bare issue numbers in map order, and the first line wins. **A non-zero exit prints nothing and means the frontier is unknown — hand the step back, and never read it as "nothing is left to do on this map".** It refuses on every read it cannot complete: a blocker call that fails twice, a `gh` that exits 0 having printed nothing, a map with no sub-issues at all (far more often the wrong issue number than a finished map), and a claim store it cannot confirm belongs to your own tree. **The one thing it guarantees is that the frontier printed may be shorter than the truth, never longer** — so a line it prints is safe to start, and a line it omits may still be free. An unreadable liveness oracle is the case that shortens it: that one warns on stderr and answers anyway, every claim standing. **Any warning on stderr — a drop note apart — means the list is not usable as printed, so never redirect stderr away.** Known hole, neither warned nor refused: a single corrupt record inside an otherwise readable claim store is dropped silently, so the claim filter can come back short — mantahostels#1186. The command only ever reads.
  - `--numbers` is the older, narrower form: the claimed issue numbers alone, for a caller assembling the rest itself. There it is a **drop-list**, so its non-zero exit means *drop nothing*, and a claim store from another tree only warns.
  - **Assembling it by hand carries the traps `--map` now encodes** (see **Blocking** above and `rule:dependency-edge-false-success` under **Two dependency graphs** below). Blockers come from `gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by` — an entry there with `"state": "open"` means blocked. Where dependencies aren't available, fall back to an open issue in the `Blocked by` line.
- **Claim**: see `rule:issue-claim-scope`, under **Claiming** above.
- **Resolve**: `node scripts/resolve-ticket.js <n> --comment-file <f> --decision "<line>"` (#534): comment, close, claim release and map line in one call. **The resolution comment carries a `**Bound:**` line** (mantahostels#1820): what was read exhaustively, what was only sampled or cited. **It also carries a `**Values:**` line** (#1707): each value it relies on that is house — `<value> — house: #N`, the ruling that made it a house decision — or untraced — `<value> — untraced`, no source and no house decision — or `none`. A sourced value is not listed and keeps its inline source; a relied-on value with neither a source nor an entry counts as untraced. An audit tracing one rewrites its entry in place as `<value> — traced: <source or house #N> (<audit #>, <date>)` — a spec's `## Values` entry through `scripts/issue-body.js replace`, a comment's through `gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -F body=@<file>`. No back-fill: an older value is marked when next relied on. **And a `**Practice:**` line** (#2325): the Leading practice declaration in `~/.claude/CLAUDE.md`, one of `ran — <note>`, `covered — <note>, <Researched date>`, `skipped — <exempt kind>` or `none-fits — nearest <craft>`. `resolve-ticket` refuses a comment missing any of the three, checking `**Practice:**` for presence only; a not-planned close owes no `**Values:**` or `**Practice:**` line. One naming a commit sha also carries a `**Door:**` line (§Every close that names a commit says whether it can be undone).
- **Exhausted map**: the frontier query prints nothing — drop notes naming only specs and briefs included — and *Not yet specified* is empty, yet the map stays open — a card's own issue outlives its map (`rule:card-close-by-hand`), and a dormant one waits on something outside the tracker. `scripts/pick-next.js` still reads it as takeable (`map root`, `takes:wayfinder`, no open child to exclude it), so **the session that declares exhaustion changes what the map routes to, the same turn**. Three branches:
  - **The map's destination is a hand-off to another command — a spec, tickets, an implementation:** relabel it to that command's `takes:` value (`takes:to-spec` for `/to-spec <map>`) and write no gate. `disable-model-invocation` bars only the Skill tool; `scripts/dispatch-sessions.sh` types the prompt, so a dispatched session runs the command as the founder would. A gate reading "the founder types `/<command>`" silently removes the map from dispatch (#411); `scripts/check-issue-labels.js` reports that shape as COMMAND-GATE.
  - **The map ends in several destinations, one brief filed under it per deliverable:** label each brief `kind:brief`, and the map `takes:children` — `pick-next` holds back an issue with an open child, and `scripts/retire-stale-containers.js` moves the map to `takes:triage` when the last child closes, where a session decides whether the destination was reached (#578). **A brief lives until its spec exists** (#606): `/to-spec` files the spec under the brief, reads the brief's comments and writes every founder ruling, chosen value, captured fact or correction the spec body lacks into that body (§Editing an issue body — never as a comment), then runs `node scripts/promote-spec.js <brief>`, which re-parents the spec under the map and closes the brief. **Unenforced**: nothing can tell a ruling from a note, so the check is the session's; `scripts/check-issue-labels.js` reports an open brief still holding a spec.
  - **The map is dormant on something outside the tracker:** write the gate line — `rule:roadmap-gating`'s condition row, the condition being what would re-open the map. Without it the map is redispatched on every run (mantahostels#2923).
<!-- rule:wayfinder-ops-shapes:end -->

### Two dependency graphs — do not conflate them

<!-- rule:dependency-edge-false-success:begin -->
**On the two native endpoints below a false success is the ordinary failure.**

- `POST …/dependencies/blocked_by` takes the blocker's numeric **database id**
  (`--jq .id`), never the `#number` or `node_id`, and its response echoes the
  child's number and title — which is not confirmation that the edge landed.
- **Reading the canonical list back in the same chained command returns an empty
  array.** Verify in a separate call a few seconds later, and never gate on
  `issue_dependencies_summary.blocked_by`, which is stale in practice.
- **Sub-issues cap twice, each refusal a 422, and the remedies differ.** At 7
  layers, give the new issue the **same parent**. At 100 children, closed ones
  counted, a peer does not help: re-root the closed history under an archival
  container (mantahostels#1442) with `node scripts/archive-closed-children.js <map>` (#92),
  linked under the map last. `scripts/link-sub-issue.sh <parent> <child>` makes the
  ordinary link and reads a 422 naming an existing parent as success, so the
  re-rooting takes the raw call with `-F replace_parent=true`.
<!-- rule:dependency-edge-false-success:end -->

- **`needs:` in the roadmap** is **card → card**. It says which other cards must land before this one starts.
- **GitHub issue dependencies** are **ticket → ticket**, usually ordering the decision tickets under one wayfinder map.

**Edges may cross maps** (ruled 2 August 2026; the commit is the only record, no issue). A `blocked_by` between tickets sharing no parent is correct wherever one genuinely gates the other — mantahostels#76 is blocked by both mantahostels#73 (standalone) and mantahostels#68 (a sub-issue of the mantahostels#51 spec). **Do not remove one as non-conforming:** its consumer is the GitHub UI's blocked indicator, not `/wayfinder`'s frontier query.
