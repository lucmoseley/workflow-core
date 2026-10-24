# Always-loaded shed candidates — a standing list

**Ticket:** mantahostels#1222 (the audit that produces this list), under map mantahostels#1055 (the always-loaded pool is over cap).
**Measured:** 24 August 2026. `CLAUDE.md` 39,526 B + `AGENTS.md` 5,967 B + `docs/working-contract.md` 4,744 B = **50,237 B** against the 49,200 B cap → **1,037 B over**.

Re-measure before use (`node scripts/check-context-budget.js`): the pool moves ~1 KB inside a day.

**The five routes** (`docs/doc-map.md` §Capture and placement §3): (a) the skill file that runs when the fact bites · (b) `scripts/inject-tracker-docs.sh`'s seven commands · (c) a pointer line in an always-loaded file · (d) nothing at all · (e) a guard that reprints the text verbatim when it fires — **behavioural test, not topical** (mantahostels#886).

Out of scope by prior ruling, not re-walked: §Gotchas' `check-manual-freshness.js` bullet (§B51 pins the wording, `Restated in:` path) · §Conventions' clobber-record sub-bullet (concision criteria protect the class by name, mantahostels#605) · §Agent skills' vendored-skills bullet (mantahostels#737, protected by behaviour) · everything in §Capture and placement §5's ledger (mantahostels#641, mantahostels#761, mantahostels#853, mantahostels#886, mantahostels#896, mantahostels#929, mantahostels#964, mantahostels#1027, mantahostels#959).

---

## Accepted candidates — ranked by net bytes returned

Every one is route **(e)** except C7 (route (c)/relocation).

| # | Span (opening clause) | File · line | Cut B | Replacement B | **Net** | Cum. | Route · trigger |
|---|---|---|---|---|---|---|---|
| C1 | *"`.husky/pre-push` prints where that sha has no marker; …"* | `CLAUDE.md` L45 | 341 | 87 | **254** | 254 | (e) `scripts/lib/test-pass-marker.js` |
| C5 | *"…, the edit possibly being finished-but-uncommitted — where a command runs a script both dirty and claimed …"* | `CLAUDE.md` L51 | 345 | 132 | **213** | 467 | (e) `scripts/warn-stale-script.js` |
| C3 | *"Release refuses a path another session holds, one that is still dirty, …"* | `CLAUDE.md` L53 | 311 | 129 | **182** | 649 | (e) `scripts/session-arbiter.js` release refusals |
| C2 | *"The denial writes the stub itself; finish it with `… debt own …`"* | `CLAUDE.md` L52 | 164 | 0 | **164** | 813 | (e) `session-arbiter.js` `denyReason` |
| C8 | *"— one of `wayfinder`, `to-spec`, `to-tickets`, `implement`, `triage`, `human`, `children`, …"* | `CLAUDE.md` L57 | 147 | 0 | **147** | 960 | (e) `scripts/guard-issue-create-label.sh` |
| C7 | *"(earlyoom's 794 MB + that count's dip — 589 / 990 / 1271 MB — + ~300 MB fitted margin; mantahostels#463 …)"* | `CLAUDE.md` L95 | 129 | 0 | **129** | **1,089** | (c) relocate to `docs/environment.md` |
| C6 | *"A clean `git status` does not mean free (mantahostels#66: a file reads clean …)"* | `CLAUDE.md` L48 | 105 | 0 | **105** | 1,194 | (e) `session-arbiter.js` `denyReason` |
| C11 | *"— `debt clear <path> <issue>`, refused on a bare path where more than one stands"* | `CLAUDE.md` L52 | 88 | 0 | **88** | 1,282 | (e) `debt clear` ambiguous refusal |
| C4i | *"it names the newest sweep carrying a verdict, its age and how far HEAD is ahead, and"* | `CLAUDE.md` L44 | 85 | 0 | **85** | 1,367 | (e) `scripts/check-ci-status.js` own output |
| C9 | *"— a raw body write erases whatever a parallel session wrote in the window (mantahostels#128)"* | `CLAUDE.md` L56 | 83 | 0 | **83** | 1,450 | (e) `scripts/guard-issue-body.sh` deny |
| C4ii | *"and `gh workflow run` answers `HTTP 403` on the agent token"* | `CLAUDE.md` L44 | 60 | 0 | **60** | 1,510 | (e) `check-ci-status.js` `WHO_CAN_RUN_IT` — **conditional fire, lowest confidence** |
| C10 | *"…, which exits non-zero on a held file"* | `CLAUDE.md` L55 | 37 | 0 | **37** | 1,547 | (e) `claim` prints `denyReason` on a held path |

**The 1,037 B breach clears at C7 — six cuts.** Total available from this walk: **1,547 B**.

## The evidence behind each (e) claim

**C1 — `.husky/pre-push`.** The hook runs `scripts/check-test-marker.js`, which prints `warningFor()` from `scripts/lib/test-pass-marker.js`: `missingWarning()` and `dirtyWarning()` between them print all four enumerated cases and the never-refuses fact. **Keep:** the headline, *"It fires in a worktree too"* (printed nowhere) and the **Unenforced** (mantahostels#987) marker, which `scripts/check-guard-registry.js` requires.

**C5 — `scripts/warn-stale-script.js` `warning()`.** Prints verbatim: `Nothing is blocked. But if the command hangs, errors strangely or answers implausibly, re-run it once the file is committed before believing the output or debugging the script.` and `Residual: a script dirty under NO claim is invisible here — a Bash-route write mints none (mantahostels#364) — so silence is not proof the file is settled.` **Keep:** the two coverage limits the warn never states — a script a command reaches past the first, and an `npm run <name>`.

**C3 — `session-arbiter.js` release.** Each refusal prints its own reason: `held by session <x>, not by this session. Only its holder can release it` · `has uncommitted changes, so the claim stands. … Commit or discard the change, then release. Re-claiming is automatic: your next write to it takes the file back.` · `could not read the claim store for <path>, so the claim stands rather than being reported gone (mantahostels#174).` · `could not read git status for <path>, so its cleanliness is unproven and the claim stands.` · `the claim on <path> changed while releasing it; nothing was dropped.` **Keep:** *"a zero exit does not prove a claim was dropped: read the output"* — read before running, printed by nothing.

**C2, C6 — `denyReason()`.** Every claim-guard deny prints both the clean-`git status`-is-not-free fact (mantahostels#66) and the `debt own` stub to complete.

**C8 — `scripts/guard-issue-create-label.sh`.** Both denies print `$(values_line)` — the seven values in full — plus the `takes:triage` fallback.

**C11 — `debt clear` ambiguous exit.** Prints one full `debt clear <path> <issue>` line per standing debt.

**C4i — `scripts/check-ci-status.js`.** Its own on-demand output prints the newest sweep's age and how many commits HEAD is ahead of it. The instruction to run it must stay; the description of what it prints need not.

**C4ii — `check-ci-status.js` `WHO_CAN_RUN_IT`.** Printed beside every `gh workflow run` line the checker offers — but only when HEAD is untested or a sweep slot was missed, so this one fires conditionally. Take it last.

**C9 — `scripts/guard-issue-body.sh`.** The deny prints the download-whole/upload-whole race (mantahostels#128).

**C10 — `claim` on a held path** prints `denyReason()` and exits 1 (session-arbiter.js L356).

**C7 is not (e).** The 1.7 / 2.1 / 2.4 GB gates a session compares against stay; only the arithmetic that derives them moves, to `docs/environment.md`, which already holds the rows.

## Rejected candidates, with reasons

| Span | File · line | B | Why rejected |
|---|---|---|---|
| *"While something runs in the background, end the turn …"* | `CLAUDE.md` L64 | 1,634 | Route (e) refused by the guard's own header: *"the deny arrives on the THIRD poll … CLAUDE.md's copy is the only one that arrives in time: do not cut it (mantahostels#964)"*. Its trailing residual sentence is also protected — guard silence a session reads (mantahostels#605). |
| *"Never cache or store OTA availability or prices …"* | `AGENTS.md` L33 | 1,041 | **Pinned.** §B15: *"Replacement — `AGENTS.md` §Business invariants owns the wording"*, and `docs/doc-map-restatements.json` `/B15[0]/path` = `AGENTS.md`. Cutting breaks the restatement check. |
| *"Never display OTA availability or prices for comparison …"* | `AGENTS.md` L34 | 1,327 | **Pinned.** §B36 `Restated in` names *"`AGENTS.md` §Business invariants (the display bullet)"*; `restatements.json` `/B36[0]/path` = `AGENTS.md`. |
| *"Infra goes to Supabase + Vercel in Singapore …"* | `CLAUDE.md` L88 | 613 | **Pinned.** §B68 `Restated in` names *"`CLAUDE.md` §Gotchas (the infrastructure bullet — the owner)"*; `restatements.json` `/B68[0]/path` = `CLAUDE.md`. |
| *"The shared working tree stays on `main` …"* | `CLAUDE.md` L41 | 1,386 | Already swept at **mantahostels#964**, which named its own residuals: `--detach`, `git worktree remove --force` and the compressed `mantahostels#245` gloss stay because no deny prints them. Re-read `guard-branch.sh` before re-opening. |
| *"Commit by pathspec, never `git add` first …"* | `CLAUDE.md` L42 | 1,056 | mantahostels#964 shed the three sub-bullets under `guard-commit-form.sh`. What remains is the rule plus warn-interpretation (*"At most one warn fires per call"*, *"both are advisory"*) — the mantahostels#605-protected class. |
| Priced-options bullet · `result:` bullet | `CLAUDE.md` L66, L67 | 984 + 673 | **mantahostels#853** already cut both to the instruction alone and bought retrieval by widening `scripts/inject-tracker-docs.sh` to all seven commands. The remainder is the trigger line. |
| Push bullet remainder | `CLAUDE.md` L44 | ~1,400 | The sweep cadence (01/06/11/16 UTC), the up-to-9-hour verdict gap, and *"Never write `result:` on the strength of the push succeeding"* are all read **before** a push. Nothing prints them, and mantahostels#948 already cut this bullet's unrunnable half. |
| `docs/working-contract.md`, every span | — | 4,744 | No trigger exists that fires **before a reply is written**, which is when every one of these binds. (a) and (b) both under-reach — they cover skills and tracker commands, not ordinary replies; (e) has no guard; (d) drops the rule. The one exception already taken: mantahostels#901 cut *"never against edit history or session recall"*. |
| `AGENTS.md` §Supervision priors, mutation-reversal bullet | `AGENTS.md` L27 | 487 | **mantahostels#641** already shed 306 B of it to `docs/agents/verification.md`. |
| §Commands bullets (`lint`, `check`, `check:staged`, `check:sh`, `test:py`) | `CLAUDE.md` L26–32 | 1,266 | Tempting under *"a cache of what the environment already answers"*, but each carries a **trap** a session meets before it reads `package.json` — two linters deliberately, the pre-13-Aug-2026 pytest install dying on `-n`, nothing else linting shell. `test:py`'s failure prints `unrecognized arguments: -n` but never *"reinstall the requirements rather than dropping the flag"*, which is the whole instruction. ~250 B at real risk. |
| §Ground truth doc-map bullet + sub-bullets | `CLAUDE.md` L18–21 | 925 + 371 + 600 + 456 | **mantahostels#1027** already shed 170 B here under (e) and named what survived: *"only *regenerate after staging, never before* is not in the checker's output"*. The rest is the §A/§B/§C read order, needed before any doc edit and printed by nothing. |
| §Agent skills vendored-skills bullet | `CLAUDE.md` L106 | 490 | Prior ruling mantahostels#737 — protected by behaviour, not bytes. |
| §Gotchas `check-manual-freshness.js` bullet | `CLAUDE.md` L82 | 591 | Prior ruling — §B51 pins the wording, `Restated in:` path. |
| §Conventions clobber-record sub-bullet | `CLAUDE.md` L49 | 2,733 | Prior ruling mantahostels#605 — the protected class by name. |
| §Machine limits, the 1.7 / 2.1 / 2.4 GB gates | `CLAUDE.md` L95 | — | Acted-on thresholds. Only the derivation moves (C7). |

## Bookkeeping noticed in passing, not shed candidates

- `CLAUDE.md` L52 cites **`(mantahostels#327, mantahostels#327)`** — the same issue twice. 7 B, and a citation that reads as two rulings when it is one.
- `docs/doc-map.md` §Capture and placement §5 books **mantahostels#929** as having shed *"the two `debt clear` spellings the arbiter prints in its own denial and in `debt list`"*, yet `CLAUDE.md` L52 carries `debt clear <path> <issue>` today. Either the shed was reverted or the ledger overstates it. C11 above re-proposes only the *refusal condition*, not the spelling — check the ledger before taking both.

## Method note

Spans were cut at bullet/sub-bullet boundaries and byte-counted including their continuation lines. Guards read in full: `guard-agent-poll.sh`, `guard-stale-script.sh` + `warn-stale-script.js`, `guard-issue-body.sh`, `guard-issue-close.sh`, `guard-issue-create-label.sh`, `session-arbiter.js` (`denyReason`, release refusals, `debt clear`, `claim`), `check-test-marker.js` + `lib/test-pass-marker.js`, `check-ci-status.js`, `check-guard-registry.js`, `check-context-budget.js`.

**Before applying any cut:** re-measure the pool, keep every rule's single enforcement marker (`check-guard-registry.js` fails a rule carrying none), and run `npm run gen:doc-map-counts` *after* staging.

---

# Register II — 27 August 2026 (mantahostels#1617)

**Ticket:** mantahostels#1617 (build the fresh shed register), under map mantahostels#1498 (`instruction-prune` — prune the always-loaded agent instruction stack).

**The list above is spent.** All twelve spans C1–C11 were taken by mantahostels#1225, mantahostels#1262 and mantahostels#1306; none survives in `CLAUDE.md` today. This section is a fresh end-to-end read, and its ids are **R1–R21** so they never collide with the C-ids above.

**Measured at the time of writing** (`node scripts/check-context-budget.js`): `CLAUDE.md` 36,690 B · `AGENTS.md` 6,148 B · `docs/working-contract.md` 716 B · `.claude/output-styles/manta-voice.md` 5,571 B · own skill and command descriptions 2,459 B = **51,584 B against a 51,588 B cap, 4 B of headroom**. mantahostels#1617's own opening figure was 24 B; ~20 B moved in a parallel session between the two readings, unattributed. Byte counts below go stale fast — re-measure before cutting.

**The three tests** this register applies, from mantahostels#1617: **no-op** (does the rule change behaviour versus Claude's default?) · **environment cache** (does it restate something `package.json`, a `--help` or a config file already says, where it goes stale silently and the environment cannot?) · **pointer** (is this reference every branch needs, or only some?). Where a span fails on retrieval rather than on content, the route letter from `docs/doc-map.md` §Capture and placement §3 is given: **(a)** the skill file that runs when the fact bites · **(c)** a pointer line in an always-loaded file · **(e)** a guard that reprints the text verbatim when it fires.

Building the register cuts nothing; each span goes to the founder individually in a later tranche.

**Not re-walked**, being refused already in `docs/doc-map.md` §Capture and placement §5: `CLAUDE.md`'s background/end-turn rule (mantahostels#964) · the `argv[0]`-not-`comm` process-counting gotcha · the release bullet's *"A **watched** path under no claim prints `No claim on <path>`"* · the push bullet's `.husky/post-commit` unpushed-count clause (all three mantahostels#1611) · and `CLAUDE.md`'s `@.claude/output-styles/manta-voice.md` import (mantahostels#1504). `.claude/output-styles/manta-voice.md`'s own voice content is out of this map's scope — the sibling map mantahostels#1496 (`agent-voice`) owns it.

## Verified route-(e) candidates — the guard's own output was read

**687 B.** Each was checked by running the guard or reading the literal string it prints (mantahostels#886).

### R1 · `CLAUDE.md` §Conventions, the uncommitted-work limb of the end-turn rule — **424 B**

The span: *"A usage-limit checkpoint … a context warning and a Stop hook are all detours: satisfy the demand, then the next tool call is the commit — `git commit -m "…" -- <paths>` — not the summary. A background job with no pending tool call is idle and nothing resumes it, so a report-shaped message ends the session wherever it stopped, uncommitted work and all (mantahostels#666)."*

`scripts/guard-uncommitted-work.js` blocks the Stop and prints, verbatim:

> *"CLAUDE.md §Conventions: a turn never ends with uncommitted work in the shared tree, and the next tool call after any Stop-hook detour is the commit, not the summary."*

plus the pathspec recipe with the paths named, *"Never `git add` first, because the index is repo-global"*, the diff-before-commit warning, and the instruction to re-send the message with its status marker.

**Residual, and why the rule's opening limb stays:** the guard fires only where this session wrote tracked files. A session that wrote none and ends on a progress report is unreached, so *"A turn ends only on a real question or a notification you are waiting for — never on a progress report"* is not covered and is not a candidate.

### R2 · `CLAUDE.md` §Gotchas, the superseded-values WARN framing — **119 B**

The span: *"**Findings are WARN, so no hit ever fails the build**, and a hit is a candidate to read, never a substitution to make."*

`node scripts/check-superseded-values.js` prints both halves at the moment of need:

> *"Each hit is a candidate, not a verdict: a superseded value can survive legitimately inside a passage that is explicitly about the old figure. Read the §B entry, then re-derive rather than string-substitute."*

and closes on `WARN: 276 off-allowlist superseded value hit(s)`. The rest of the bullet — the `check-doc-map.js` pointer assertion that refuses a `Supersedes` bullet with no key in `docs/doc-map-superseded.json` (mantahostels#1474) — is **not** printed by this checker and stays.

### R3 · `CLAUDE.md` §Conventions, *"**The `-b <name>` is not optional** (mantahostels#301, which corrected this recipe)"* — **73 B**

`scripts/guard-branch.sh`'s deny prints the recipe with the flag in it:

> *"git worktree add -b &lt;branch&gt; "$CLAUDE_JOB_DIR/tmp/&lt;name&gt;" main"*

**Residual, and it is real:** the deny arrives only on a `git checkout`/`git switch`. A session that goes straight to `git worktree add` with no branch move first never sees it.

### R4 · `CLAUDE.md` §Commands, *"`scripts/test_evidence_corpus.py` **skips unless `data/` is present**;"* — **71 B**

`scripts/test_evidence_corpus.py:42` carries `reason="local corpus absent (data/ is gitignored) — this is the expected state in CI"`, which pytest prints on every skipped run. The rest of the clause — *"the corpus is gitignored and must never be committed to make it run"* — is a **rule** the skip message does not carry, and stays.

## Duplicate spans — the same fact stated twice in the pool

**548 B.** Each pair states one fact in two places; one copy goes, the other is named.

### R5 · The `doc-sync` ruling, stated in `CLAUDE.md` and again in the section `CLAUDE.md` orders you to read — **211 B**

`CLAUDE.md` §Ground truth: *"**There is no `doc-sync` skill and no document-identifying aid** — ruled out, not deferred, at mantahostels#168 … and mantahostels#169 …"*. The same sub-bullet's preceding sentence is *"Read `docs/doc-map.md` §The propagation pass in full before propagating anything"* — and `docs/doc-map.md:3098`, inside that very section, says:

> *"**Not a skill, and not an aid.** Re-proposing a `doc-sync` skill (mantahostels#168 — the unit of a document update is one Code session, and nothing new needs building) or a tool that identifies the affected documents for you (mantahostels#169 — no aid that reads §B can fix §B being wrong) reopens two settled rulings."*

The pool copy is a duplicate sitting behind a pointer the same sentence issues. **Residual:** a session that proposes a `doc-sync` skill without first intending to propagate anything never reads §The propagation pass, so nothing stops it.

### R6 · The mantahostels#344 worktree-gates fact, stated in §Conventions and again in §Gotchas — **136 B**

§Conventions: *"A worktree is exempt from both of those branch checks — by the hook's own shared-tree test, not by hooks failing to run there (mantahostels#344)."* §Gotchas: *"**A throwaway worktree is not an escape**: since mantahostels#344 it runs the same gates on the same staged paths."* The §Gotchas copy is the one that fires where a session is actually reasoning about escaping a gate; cut the §Conventions copy. **Residual:** the branch-check exemption itself — a worktree may sit off `main` — is stated only in the copy being cut, so the surviving sentence needs the word *branch* added if this is taken.

### R7 · The no-run-is-keyed-to-your-sha fact, stated twice — **120 B**

§Conventions' push bullet: *"**No run is keyed to your sha**, so a per-sha check returns nothing — indistinguishable from a broken checker (mantahostels#949)."* §Gotchas: *"Since mantahostels#910 no run is keyed to a push, so both answer off the last scheduled sweep and the commit range it covered, never your sha."* The §Gotchas copy names the two checkers it governs by name and is the better keep.

### R8 · The neighbour-forecloses-your-amend fact, stated twice, eight lines apart — **169 B**

Push bullet: *"`git push` sends **every** commit on `main`, a parallel session's included, so a neighbour may publish your held commits first; expected, and it forecloses their amend."* Force-push sub-bullet: *"A neighbour's push publishes your commit before you amend it, and once public the amend you were holding it for is gone."* **Residual:** the *"sends every commit on `main`"* mechanism is only in the push-bullet copy — fold that clause into the survivor rather than losing it.

## No-op — the span changes no action

**392 B live**, plus R14's 140 B already taken.

### R9 · §Conventions, *"At most one warn fires per call — a `git add` warn holds back the pathspec-less one —"* — **90 B**

Guard internals. Whether one warning fires or two, the session does the same thing, which the surviving half of the sentence states: *"both are advisory, so read the index yourself before committing."*

### R10 · §Conventions, *"A verified midpoint may go out; an unverified last commit may not."* — **67 B**

Restates the rule's own opening sentence, *"Push when the suite is green on the commit being pushed."*

### R11 · §Subagent dispatch, the two correlation coefficients — **128 B**

*"correlation with cost is **0.927 for turn count against 0.178 for prompt size** (mantahostels#1086, the month of fan-out this rests on), so"*. The action is carried whole by the clause that follows: *"trimming a dispatch prompt saves nothing."* The figures are evidence for a rule already stated imperatively, and `docs/research/` holds them.

### R12 · §Subagent dispatch, the cache-write share — **110 B**

*"cache write is 42.2% of subagent spend at 12.5× cache read per token, so a cheap dispatch is not a free one."* Justification for the ~52k-token floor stated in the same sentence; the floor is what a session acts on.

### R13 · §Machine limits, the four-things-invalidate-it list — **160 B**

*"**Four things invalidate it: `maxWorkers: 2`, the 2048 MB heap, **8 cores** — and the suite's own size**, which grew 175% in a week and broke the old ladder."* No session changes what it does for knowing which four inputs the ladder rests on; the same sentence already points at `docs/environment.md` for the derivation. **Keep** *"Extrapolated below ~2.5 GB, where no run has completed"* — that is a live caution about a rung a session may actually try.

### R14 · `docs/working-contract.md`, *"Encode task order in the tooling as well as stating it …"* — **140 B — ALREADY TAKEN, 27 August 2026**

Proposed as the lowest-confidence entry here: a standing preference rather than a rule with a moment of need, read by no guard, skill or gate. **A parallel session deleted this exact span mid-ticket** — `docs/working-contract.md` 716 B to 576 B, the pool from 4 B of headroom to 153 B, which reconciles the two figures above. Its 140 B is excluded from every total below.

## Environment cache — the environment says it, and says it truly

**134 B.**

### R15 · §Machine limits, *"(9,924 MiB usable, read 18 Aug 2026 post-restart)"* — **50 B**

A dated reading of `free -m`, in a section that twice orders a session to run `free -m` or `free -h` before a build or test run. The live figure is always available and the parenthetical can only drift.

### R16 · §Agent skills, *"`grep -l 'disable-model-invocation: true' .agents/skills/*/SKILL.md` names the set."* — **84 B**

A grep a session can write from the sentence above it, which already names the flag. The *"14 of the 25"* count in the same bullet is the same fact frozen, and drifts every time a skill is vendored — but it is what makes the bullet credible at a glance, so it is **not** proposed here.

## Pointer — needed by some branches, not every one

**1,456 B, and the largest single block in this register.**

### R17 · `AGENTS.md`, the OTA price-comparison clause citations — **435 B**

The span: *"[one platform's terms] [a clause] bars the tracked link from "meta search sites, travel search sites or price comparison sites" absent written agreement; on [the other platform's] side the bar is **[its partner terms' clause]** … and **not [a neighbouring clause], which reaches sub-licensing only** (mantahostels#93 …)."*

`AGENTS.md` states its own bar for what belongs there: *"Reasoning lives in `docs/operating-manual.md` … These must fire without reading it."* What must fire without reading anything is **never display OTA availability or prices for comparison, and the consent is not held** — that survives whole. Clause numbers bite in one branch only: a session drafting a consent application or arguing the point, which opens `docs/operating-manual.md` and `docs/doc-map.md` §B regardless.

**Consequence in plain words:** an agent would still refuse to build a price comparison, but could no longer cite which contract clause forbids it without opening a document.

### R18 · `AGENTS.md`, the consent-scope and no-consent-by-email clauses — **385 B**

*"**No consent here arrives by email** — [a clause]'s "e-mail will suffice" governs press releases only. **The consent must name the price-comparison/display use** — a generic affiliate approval licenses link-tracking, not re-utilising their availability data in a comparison, [and where the application stands] (mantahostels#79)."*

Same argument as R17 and the same branch: these govern how a consent is obtained and read, not what code may do. The bullet's closing sentence — *"Nothing about how the display is built lifts this bar; only that written, correctly-scoped consent does"* — carries the whole operative rule and stays. **Take R17 and R18 together or not at all**; splitting them leaves half a citation apparatus.

### R19 · `AGENTS.md`, the *"Not ruled"* paragraph on holding OTA scores in the evidence corpus — **262 B**

*"**Not ruled:** whether *holding* OTA scores and counts in the internal evidence corpus … carries its own exposure. That is mantahostels#83's question; this ruling neither clears nor bars it, and bars publication either way."*

An **open question**, not a rule — it forbids nothing and permits nothing. It changes behaviour only for a session working mantahostels#83, which will read mantahostels#83. **Residual:** it currently stops a session reading the bullet above it as clearance to seed scores into `docs/data/`; the surviving text must keep the words *"bars publication either way"* or that reading opens up.

### R20 · `CLAUDE.md` §Ground truth, the `manual-sync` targeted-correction clause — **374 B**

*"That skill has two routes in: a **full sync**, and — for one already-settled fact that cannot wait for the next run — a **targeted correction**, which must cite where the fact was settled and log itself on the manual's *Corrections since last sync* line, under the further constraints in `.claude/skills/manual-sync/SKILL.md` §Targeted-correction mode (settled at mantahostels#82)."*

**Route (a).** `.claude/skills/manual-sync/SKILL.md` carries §Targeted-correction mode and the *Corrections since last sync* obligation in full — verified at lines 29, 31, 45, 146 and 148 of that file. A session can only execute either route by invoking the skill, which loads it.

**Residual:** a session holding one settled fact needs to know the targeted route **exists** before it decides to invoke `manual-sync` at all. Replace with a short clause naming both routes — *"only the `manual-sync` skill writes it, by full sync or targeted correction"* — rather than deleting outright.

### R21 · `CLAUDE.md` §Gotchas, *"**Nothing local runs the tests.** `.husky/pre-commit` never runs the suite, so run `npm run test` yourself before pushing."* — **123 B**

The push rule in §Conventions already orders the same act with more precision: *"run `npm run test`, `npm run typecheck` and the edited file's own checker, then `git push origin main`."* The §Gotchas bullet's remaining half — the two checkers that report a red, and that both answer off the last scheduled sweep — is unique and stays.

## Examined and refused — do not re-walk

Recorded so a later tranche does not spend a session re-deriving these.

- **§Gotchas' `check-machinery-superseded.js` bullet.** The checker prints its own candidate-not-verdict line, but the bullet's content is the **obligation** — *"retiring a repo-machinery figure obliges you to write its needles into `docs/machinery-superseded.json` that session, percent *and* decimal spelling"* — and that fires when a figure is retired, which is not when the checker runs. Route (e) fails on timing, exactly as mantahostels#964 found for the agent-poll rule.
- **`AGENTS.md`'s whole-file-restore bullet** (*"`cp`, `git checkout -- <path>`, `git restore` and `git stash` all write back a snapshot taken before any concurrent edit …" (mantahostels#250)*). The arbiter's content record reports a change **you did not make**; a destructive command you ran yourself is the mantahostels#329 blind spot and is never reported. Nothing retrieves this at the moment of need.
- **§Conventions' branch rule, the `node_modules`/`npx` clause.** `scripts/guard-branch.sh`'s deny was read in full: it prints the worktree recipe and the pathspec-restore alternative, and says nothing about `node_modules`, `npx @biomejs/biome`, or `npx biome` being an unrelated package. Route (e) does not reach it.
- **§Agent skills, the *"14 of the 25"* count.** Environment-cacheable in principle (R16's grep produces it), but it is what makes the bullet credible without running anything.

## Totals

| Class | Spans | Bytes |
| --- | --- | --- |
| Verified route (e) | R1–R4 | 687 |
| Duplicate | R5–R8 | 636 |
| No-op | R9–R13 | 555 |
| Environment cache | R15–R16 | 134 |
| Pointer | R17–R21 | 1,579 |
| **Total** | **20 live, 1 already taken** | **3,591** |

Against the 153 B of headroom left after R14 went, this register is **~7% of the 51,588 B cap** and enough to fund several tranches. The pointer class alone (1,579 B) is 42% of it and sits in four `AGENTS.md` spans plus two `CLAUDE.md` spans — the concentration is in the OTA-consent apparatus, not in the machinery rules the map was chartered to prune.

## Tranche 3 — the branch and pull cluster (mantahostels#1648, spec mantahostels#1641)

### R3 is revived — the guard now fires on the route that refused it

R3 was refused because `scripts/guard-branch.sh` fired only on a `git
checkout`/`git switch`, so a session going straight to `git worktree add` never
met the recipe. mantahostels#1648 widened the guard: `git worktree add` carrying neither
`-b`/`-B` nor `--detach` is now denied with the same refusal shape as an
off-`main` checkout, and `-b`, `--detach`, `--orphan` and every other `worktree`
verb stay allowed. The residual R3 recorded is closed for the Bash-tool route;
a `git worktree add` run outside Claude Code still sees no hook.

### The trigger audit, run behaviourally

Both guards were run as Claude Code runs them — hook JSON on stdin,
`CLAUDE_PROJECT_DIR` at a throwaway repo, `CLAUDE_CONFIG_DIR` and `TMPDIR`
redirected — and the real output read.

| Rule | Route to the mistake | Guard sees it? | Verdict |
| --- | --- | --- | --- |
| Shared-tree branch | `git checkout`/`git switch` off `main` | yes | printable-in-time |
| Shared-tree branch | `git worktree add` with no `-b`/`--detach` | yes, since mantahostels#1648 | printable-in-time |
| Shared-tree branch | a commit made in the shared tree off `main` | `.husky/pre-commit`, not the hook | unprintable by construction — a second limb |
| Shared-tree branch | `WFC_ALLOW_BRANCH=1` | never mentioned in any refusal | unprintable by construction — an omitted escape |
| Shared-tree branch | a checkout run outside Claude Code | no hook at all | unreachable |
| Fast-forward-only | `git pull`, `git pull --rebase` | yes | printable-in-time |
| Fast-forward-only | `git rebase`/`git merge origin/main` after a fetch | no | unreachable — named inside the fragment instead |

**The fast-forward rule's route is sound by construction and proven by use.**
`scripts/guard-pull-form.sh` has fired **17** times
([docs/research/guard-fire-counts.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/guard-fire-counts.md), mantahostels#2140).

### Bytes

**Opening reconciliation.** Spec mantahostels#1641 was written against `CLAUDE.md` at **33,949 B**; it measured
**34,783 B** on 28 August 2026, 834 B higher, parallel sessions having written to
it in between. The spec's per-rule figures also differ: it put the branch bullet
at 1,061 B (measured **1,068 B**) and the fast-forward bullet at 720 B (measured
**536 B** — the spec's figure included the *"Never force-push `main`"*
sub-bullet, which has no guard and is not relocated).

| | Before | Drafted | Estimated shed |
| --- | --- | --- | --- |
| Shared-tree branch bullet | 1,068 B | 762 B | 306 B |
| Fast-forward-only bullet | 536 B | 311 B | 225 B |
| **Both** | **1,604 B** | **1,073 B** | **531 B** |

**No `CLAUDE.md` byte was cut by this tranche.** Spec mantahostels#1762 moved the
emission point from a `gp_deny` refusal to a pre-emptive `gp_warn` injection
while it was being built, and the ticket stopped before deleting any prose. The
762 B and 311 B are what two *drafted* replacement bullets measured; the drafts
are not in the repo. **The 531 B is an estimate of what this route would shed,
never a shed.**

**Fragment bytes, which sit outside both caps and are rationed by measurement
alone:** `docs/agents/rules/branch-shared-tree.txt` **987 B**,
`docs/agents/rules/pull-fast-forward.txt` **827 B** — **1,814 B** between them,
raw `wc -c` (986 B and 826 B as emitted). Cumulative store size after this
tranche: **1,814 B** (it is the first tranche to write a fragment;
mantahostels#1644 built the store empty).

**40.0% of the cluster sheddable** — 531 of 1,329 B, leaving out the 275 B
`node_modules`/`npx` clause, which is in spec mantahostels#1641's §Out of Scope
and so never a candidate. mantahostels#1624 measured 33.6% of a guard-adjacent
span as printable; this tranche beats it on a rule *body*, which the spec
expected to be more printable than a trailer. What holds the branch bullet down
is the `WFC_ALLOW_BRANCH` escape and the `.husky/pre-commit` limb, two of
mantahostels#1624's unprintable-by-construction categories.

**Consequence for the spec's yield band.** mantahostels#1641 projected 3,400–6,200 B across
four tranches from a 9,791 B pool, which carries the fast-forward bullet's
184 B overcount from this cluster's reconciliation (720 B stated, 536 B
measured → ~9,607 B). At 40% the pool yields
**~3,840 B, inside** the band. One tranche is a thin base for that
extrapolation — the claim cluster (5,592 B) dominates the pool and has not run —
and mantahostels#1762 re-derives the yield at 24–33% on the pre-emptive route,
so mantahostels#1641's band is not the one to plan against.

## Tranche 4 — the tracker cluster (mantahostels#1649, spec mantahostels#1641, under mantahostels#1762's re-aim)

Five rules across four guards: the issue-body-edit rule, the `takes:` label rule,
the outstanding-line close rule, the `/card-close` rule and the roadmap-validity
rule.

**The emission point is the deny, not the pre-emptive injection.** Spec
mantahostels#1762 puts the *new* emission point in a `gp_warn` fired on the
command and keeps the `gp_deny` limb this tranche builds. What this tranche does **not** do is the pre-emptive half, which needs `gp_rule` in
`scripts/lib/guard-parse.sh` (mantahostels#1762's tranche 1), unbuilt when this tranche ran. The
fragments are written so `gp_rule` can print them unchanged.

### The trigger audit, run behaviourally

Each guard was run as Claude Code runs it — hook JSON on stdin,
`CLAUDE_PROJECT_DIR` at a throwaway repo, `CLAUDE_CONFIG_DIR` redirected, `gh`
shimmed where the guard calls it — and the real output read.

| Rule | Route to the mistake | Guard sees it? | Verdict |
| --- | --- | --- | --- |
| Issue-body edit | `gh issue edit --body`/`-b`/`--body=`/`--body-file` | yes | printable-in-time |
| Issue-body edit | `gh api` PATCH, GraphQL `updateIssue` | yes (mantahostels#284's reader) | printable-in-time |
| Issue-body edit | a wrapper, a non-`gh` client, the founder's terminal | no | unreachable — named inside the fragment instead |
| `takes:` label | `gh issue create` with no label, or a label of another family | yes | printable-in-time |
| `takes:` label | `gh issue create --label takes:<unknown>` | yes | printable-in-time |
| `takes:` label | the GitHub UI, an unreadable `gh api` create | no | unreachable — named inside the fragment |
| Close outstanding | `gh issue close <n>`, however the number and flags are spelled | yes | printable-in-time |
| Close outstanding | the GitHub UI, `gh api --method PATCH … -f state=closed` | no | unreachable — named inside the fragment |
| `/card-close` | `gh issue close <n>` on an unparented card-prefixed issue whose card is not `done` | yes | printable-in-time |
| Roadmap validity | a commit staging an invalid `docs/reference-roadmap.html` | yes, in `.husky/pre-commit` | printable-in-time — the gate refuses the commit and prints the rule |
| Roadmap validity | an invalid roadmap reaching `main` by a route running no hook | the scheduled `Document guards` job (`--tree`), after the fact | injectable-late — named inside the fragment |

All five are printable-in-time on at least one route, so all five are cut
candidates.

### Bytes

**Opening reconciliation.** The ticket's census put the cluster at 1,300 B across
five bullets (264 / 217 / 280 / 251 / 288). Measured on 28 August 2026, at
`CLAUDE.md` **34,991 B**: 265 / 218 / 282 / 251 / 288, **1,304 B** — 4 B higher,
the ticket's figures having been taken before a parallel session's edit. Spec
mantahostels#1762 measured `CLAUDE.md` at 34,952 B the same day; 39 B of drift between two
readings.

| | Before | After | Shed |
| --- | --- | --- | --- |
| Issue-body edit | 265 B | 149 B | 116 B |
| `takes:` label | 218 B | 169 B | 49 B |
| Close outstanding | 282 B | 135 B | 147 B |
| Roadmap validity | 251 B | 181 B | 70 B |
| `/card-close` | 288 B | 164 B | 124 B |
| **All five** | **1,304 B** | **798 B** | **506 B** |

The five replacement bullets were drafted and measured — the drafts are on
mantahostels#1649, as a comment — and
`node scripts/check-guard-registry.js --root <copy>` was run over a materialised
tree carrying them: 5 triggers resolved, no `UNPRINTED-RULE`, exit 0.

**38.8% of the cluster**, against tranche 3's 40.0% and mantahostels#1624's 33.6%
for a trailer. Two rule bodies in this cluster are near-pure enforcement trailers
already — the `takes:` bullet sheds only 49 B of 218 B because its prose is a
pointer to `docs/agents/triage-labels.md`, which stays.

**Fragment bytes, which sit outside both caps and are rationed by measurement
alone:** `issue-body-clobber.txt` **1,544 B**, `card-close-by-hand.txt`
**1,078 B**, `close-outstanding.txt` **1,014 B**, `issue-takes-label.txt`
**754 B**, `roadmap-validity.txt` **596 B** — **4,986 B** across the five,
raw `wc -c` (one byte less each as emitted). Cumulative store size after this
tranche: **6,800 B** raw (1,814 B from tranche 3, plus these five).

The fragments are 3.8× the prose they replace, because each carries what the
CLAUDE.md bullet did not: the escapes (`--reason "not planned"`), the silence
conditions (a wrapper, the GitHub UI, a `gh api` PATCH) and the compliant
command spellings.

### Mutation tests, the tracker cluster

Eight ran, as `AGENTS.md` §Supervision priors requires, each reversed with the
inverse targeted edit and the file re-measured afterwards:

| # | Mutation | Test that failed |
| --- | --- | --- |
| 1 | `$(body_rule)` removed from `guard-issue-body.sh`'s deny | all four issue-body rule cases |
| 2 | the silence-conditions clause deleted from `issue-body-clobber.txt` | "names the routes nothing sees" |
| 3 | `$(label_rule)` removed from `deny_missing` | "carries the whole rule — no label at all" |
| 4 | the `--reason "not planned"` exemption deleted from `close-outstanding.txt` | "carries the exemption a deny would omit" |
| 5 | `$(card_rule)` removed from `deny_card` | "the card refusal carries the whole rule" |
| 6 | `...roadmapRule()` removed from index-mode advice | "index mode carries the whole rule" |
| 7 | the ESCAPES clause deleted from `card-close-by-hand.txt` | "the card refusal carries the whole rule" |
| 8 | the stage-first clause deleted from `roadmap-validity.txt` | "names the stage-first ordering" |

**An id-keyed assertion cannot detect a fragment mutation**, which is why 1, 3,
5 and 6 mutate the *wiring* instead: `expect(deny).toContain(ruleText(id))`
reads the fragment at test time, so deleting a clause moves both sides together
and the test stays green. Mutations 2, 4, 7 and 8 are the fragment half, and
each needs a **literal anchor** — one clause quoted in the test rather than read
from the store, as each of the four fragments carries.

### The Tranche 4 shed — 28 August 2026

The founder approved all five deletions the same day, and each bullet was cut
exactly as drafted, so the `Before | After | Shed` table above is the landed
shed. `CLAUDE.md` **35,401 B → 34,895 B**, and the always-loaded pool now reads
**51.2 KB of 55.9 KB, 4,779 B of headroom** (`node scripts/check-context-budget.js`).
`scripts/check-guard-registry.js` resolves **5 triggers** against the store, so
a later guard rewrite that orphaned one of these rules would fail the build —
the cross-check mantahostels#1644 built was exercised by nothing until this tranche.

**This is the first tranche of mantahostels#1639 to cut a byte.** Tranche 3 stopped at the
approval gate and its 531 B stays an estimate; mantahostels#1641's four-tranche projection
should be re-derived against 506 B measured on 1,304 B of real pool, not against
that estimate.

**The store is not free and is not netted off.** Five fragments hold 4,986 B, and
a fragment is paid by every session that trips its guard. The case is adherence —
fewer simultaneously-live instructions, mantahostels#1714's finding — never tokens, and this
tranche does not book a saving.

**One residual:** the pre-emptive limb was unbuilt at the cut. A session meets
these five rules only *after* a guard refuses it, so the deletions cost one
wasted tool call apiece and no more. mantahostels#1762's tranche 1 (`gp_rule`) closes that;
the fragments are written to be printed by it unchanged.

## Tranche — the commit and branch cluster, pre-emptive limb (mantahostels#1647, spec mantahostels#1762)

The first tranche on **route (f)**, `docs/doc-map.md` §Capture and placement §3:
a guard that injects the rule *before* the call it governs, rather than printing
it in a refusal after. `gp_rule` (mantahostels#1804) is the emitter; this is its first
caller.

### R3 is revived a second time, and this is the half it actually needed

mantahostels#1648 widened `scripts/guard-branch.sh` to **deny** a bare `git worktree add`,
and §Tranche 3 above recorded R3 as revived on that. **That was half an
answer.** The route R3 was refused for is the *sanctioned* one — `git worktree
add -b <name>` — which is never denied, so no refusal could ever carry the
recipe to a session that spelled it right. The pre-emptive limb built here fires
on the allowed command:

    git worktree add -b side <dir> main   → INJECT (no permissionDecision)
    git worktree add --detach <dir>       → INJECT
    git worktree add --orphan <dir>       → INJECT
    git checkout main                     → INJECT (the repair is branch work)
    git worktree add <dir>                → DENY, carrying the same fragment
    git worktree list / remove / prune    → SILENT
    git checkout -- a.md / git checkout a.md → SILENT

### The trigger audit, run behaviourally

Both guards were run as Claude Code runs them — hook JSON on stdin,
`CLAUDE_PROJECT_DIR` at a throwaway repo, `CLAUDE_CONFIG_DIR` and `TMPDIR`
redirected — and the real output read. `scripts/guard-branch.test.ts` and
`scripts/guard-commit-form.test.ts` hold every row as an assertion.

| Rule | Route to the mistake | Guard sees it? | Verdict |
| --- | --- | --- | --- |
| Commit-by-pathspec | `git commit` with no pathspec | yes — warn, and the injection defers to it | injectable-in-time |
| Commit-by-pathspec | `git commit -m … -- <paths>`, the correct form | yes — clean, so the rule is injected here | injectable-in-time |
| Commit-by-pathspec | `git add <paths>` | yes — warn, and the injection defers to it | injectable-in-time |
| Commit-by-pathspec | `git commit -a`/`-am`/`-i` | yes — deny, reprinting its own text | injectable-in-time |
| Commit-by-pathspec | the merge family (`merge`, `rebase`, `cherry-pick`, `revert`, `am`) | judged, but handed nothing — none stages a pathspec | out of scope, deliberately |
| Commit-by-pathspec | a commit from the founder's terminal, a script, or a `>` redirect | no hook at all | unreachable — named inside the fragment |
| Shared-tree branch | `git worktree add -b`/`--detach`/`--orphan` | yes, since this tranche | injectable-in-time — **the row R3 needed** |
| Shared-tree branch | `git checkout main`, the repair | yes, since this tranche | injectable-in-time |
| Shared-tree branch | `git checkout`/`git switch` off `main` | yes — deny, since mantahostels#1648 | injectable-in-time |
| Shared-tree branch | `git worktree add` with no `-b`/`--detach` | yes — deny, since mantahostels#1648 | injectable-in-time |
| Shared-tree branch | a commit made in the shared tree off `main` | `.husky/pre-commit`, not the hook | **now printable** — written into the fragment as a second limb |
| Shared-tree branch | `WFC_ALLOW_BRANCH=1` | — | **now printable** — written into the fragment as the one escape |
| Shared-tree branch | a checkout outside Claude Code, or through `xargs`/`env`/`sudo` | no hook at all | unreachable — named inside the fragment |

**Two rows flipped that a deny could not.** §Tranche 3 classified the
`.husky/pre-commit` limb and the `WFC_ALLOW_BRANCH` escape *unprintable by
construction* — mantahostels#1624's two categories. A refusal cannot carry an escape from
itself, and cannot describe a limb it is not. A **pre-emptive injection is not a
refusal and has nothing to omit**, so both were written into the fragment and
both are now retrievable.

### The latch, measured

One emission per session per id, keyed on `(id, agent, session_id)`. Probed
behaviourally: session A's second `git worktree add -b` and second
`git commit -- <paths>` each emit **nothing**; session B's first emits the whole
fragment.

### Bytes

**Fragments, which sit outside both caps and are rationed by measurement alone:**

| Fragment | Before | After | Δ |
| --- | --- | --- | --- |
| `docs/agents/rules/branch-shared-tree.txt` | 986 B | 1,342 B | +356 B |
| `docs/agents/rules/commit-pathspec.txt` | — | 1,441 B | +1,441 B |

Every figure here is the **emitted** length — what `rule_text` returns, trailing
newline trimmed, which is `wc -c` minus one. Cumulative store size after this
tranche, all eight fragments: **8,590 B** (`commit-pathspec` 1,441 ·
`issue-body-clobber` 1,543 · `branch-shared-tree` 1,342 · `card-close-by-hand`
1,077 · `close-outstanding` 1,013 · `pull-fast-forward` 826 ·
`issue-takes-label` 753 · `roadmap-validity` 595). No fragment but this
tranche's two moved.

**The `+356 B` on the branch fragment buys the two flipped rows above** — the
second limb and the escape.

**`CLAUDE.md` spans this tranche makes sheddable, measured 29 August 2026:**

| Span | Bytes |
| --- | --- |
| §Conventions shared-tree branch bullet (line 43) | 1,068 B |
| §Conventions commit-by-pathspec bullet + its two sub-bullets (lines 44-46) | 1,640 B |
| **Total** | **2,708 B** |

**This table is a pool, not a shed:** the 2,708 B is what the tranche made
retrievable. mantahostels#1498's approval gate — *"each deletion is put to the
founder individually before it goes"* — binds the cut, which is §The shed landed
below.

**Out of scope and staying, deliberately:** the branch bullet's 275 B
`node_modules`/`npx` clause. It sits in spec mantahostels#1641's §Out of Scope and is
recorded at `docs/doc-map.md` §Capture and placement §5 as examined and refused.
Route (f) *could* carry it — the injection has room — but a refused candidate is
not re-proposed on a mechanism change alone, so it was written into the fragment
and then taken back out.

### Cap headroom on the `git commit` trigger, for mantahostels#1805 and mantahostels#1787

`gp_rule`'s ceiling is **4,000 B** (`GP_RULE_CAP`). This tranche's call on
`git commit` names **one** id and spends **1,441 B, 36% of it** — deliberately
scoped, not a blanket request, leaving **2,559 B** for mantahostels#1805's §Gotchas ids on
the same trigger. Spec mantahostels#1762 measured the whole `git commit` cluster at ≈6.1 KB,
so the ceiling still binds: something on that trigger will defer, and `gp_rule`
defers whole ids in priority order rather than truncating.

The `git checkout`/`git worktree` trigger spends **1,342 B, 34%**, and is not
shared with any other cluster today.

**These are the largest single injections this tranche produces, and are the
figures mantahostels#1787 should seed route (f)'s shared ratchet from.**

## The shed landed — approved and cut the same day (mantahostels#1647)

The founder approved both deletions on 29 August 2026, put individually per
mantahostels#1498. The §Tranche entry's 2,708 B pool was measured before a parallel session
trimmed the branch bullet; the real spans and the real shed:

| Span | Before | After | Shed |
| --- | --- | --- | --- |
| §Conventions shared-tree branch bullet | 1,069 B | 572 B | 497 B |
| §Conventions commit-by-pathspec bullet + two sub-bullets | 1,568 B | 383 B | 1,185 B |
| **Both** | **2,637 B** | **955 B** | **1,682 B** |

**63.8% of the cluster shed** — against §Tranche 3's 40.0% on the deny route
over the same subject matter, and inside spec mantahostels#1762's assumed 52-70% pass rate.
`CLAUDE.md` **35,833 B → 34,151 B**; pool headroom **2,938 B → 4,620 B**
(`node scripts/check-context-budget.js`).

**This is the first measurement of the pass rate mantahostels#1762 could only assume**, and
it lands mid-band on one tranche. One tranche is a thin base: this cluster is
the one whose rules a guard already reprinted in full, so it is the friendliest
case in the pool, not a representative one.

Ledger entry: `docs/doc-map.md` §Capture and placement §5, which also records
that R3's *examined and refused* verdict no longer holds.

## Tranche — the claim cluster, pre-emptive limb (mantahostels#1646, spec mantahostels#1762)

The second tranche on **route (f)**, and the largest single block in the spec's
byte census. Five rules leave `CLAUDE.md` §Conventions for `docs/agents/rules/`,
where `scripts/guard-file-claim.sh` hands them to a session on its first writes
to a claimed tier.

### The trigger audit, run behaviourally

`scripts/guard-file-claim.test.ts` holds every injection row as an assertion.
The five no-hook rows — the release, `debt own` on a bare `HELD` path, the
Bash-route spellings, a script writing a tracked doc, and the founder's
terminal — are the audit's own reading, and nothing could assert them.

| Rule | Route to the mistake | Guard sees it? | Verdict |
| --- | --- | --- | --- |
| File claim | a write to `docs/`, `.claude/`, `CLAUDE.md`, `AGENTS.md` | yes — clean, so the rule is injected here | injectable-in-time |
| File claim | the same write while a live session holds the file | yes — deny, and the injection defers to it | injectable-in-time |
| File claim | a write under `scripts/`, the detect tier | yes — clean, never refused | injectable-in-time |
| File claim | a write outside both tiers | judged, and handed nothing | out of scope, deliberately |
| Release | any release, ever | no hook — nothing observes a release, or its absence | **only printable pre-emptively** |
| Denied-edit debt | the denial that mints the stub | yes — the arbiter's refusal already carries both `debt` commands | injectable-in-time, and reprinted |
| Denied-edit debt | `debt own` on a bare `HELD` path, with no denial | no hook — there is no denial to print on | **only printable pre-emptively** |
| Bash-route | `cp`, `mv`, `tee`, `>`, `git restore`, `sed -i`, a heredoc | no hook — the claim guard watches the three tools alone | **only printable pre-emptively** |
| Script self-claim | a script writing a tracked doc | no hook — the write raises no `PreToolUse` at all | **only printable pre-emptively**, at the moment the script is WRITTEN |
| any | a write from the founder's terminal or an external client | no hook at all | unreachable — named inside the fragments |

The script self-claim rule is injected on a write to `scripts/`: the moment the
script is being written is the moment the call can still be added.

### The tier test, and why it is the guard's own

`gp_rule` fires only where the write is on a claimed tier — `docs/`, `.claude/`,
`CLAUDE.md`, `AGENTS.md` or `scripts/`. Without it a session working only in
`app/` would be handed 5.3 KB of claim rules it can never need. The arbiter stays the
authority on what is claimed and what is refused (mantahostels#102); the prefix test in the
guard chooses only whether to speak, so drift there costs a hint not given,
never a wrong verdict.

**The arbiter speaking silences the injection.** Where the arbiter printed
anything — a refusal, a clobber notice, a straddle notice — that object is
already on stdout and the rules defer, unlatched, to the session's next write.

### Bytes

**Fragments, which sit outside both caps and are rationed by measurement alone.**
Emitted length throughout — what `rule_text` returns, trailing newline trimmed,
which is `wc -c` minus one:

| Fragment | Before | After | Δ |
| --- | --- | --- | --- |
| `docs/agents/rules/file-claim.txt` | — | 2,351 B | +2,351 B |
| `docs/agents/rules/claim-release.txt` | — | 1,773 B | +1,773 B |
| `docs/agents/rules/denied-edit-debt.txt` | — | 1,107 B | +1,107 B |
| `docs/agents/rules/claim-bash-route.txt` | — | 942 B | +942 B |
| `docs/agents/rules/script-self-claim.txt` | — | 463 B | +463 B |
| **This tranche** | — | **6,636 B** | **+6,636 B** |

Cumulative store size after this tranche, all thirteen fragments: **15,226 B**.
No fragment but this tranche's five moved.

`file-claim` and `claim-release` carry the part of `CLAUDE.md` lines 51 and 56
that otherwise survives only in `session-arbiter.js`'s refusal — the denied
branch, which this tranche's own audit says cannot carry these rules: the
`release --force` escape and its refuses-on-a-live-holder semantics, the in-band
`request`, the abandon-and-owe-a-debt tail, the release-refused clobber warning,
and the session-start standing-claims report (mantahostels#1747).

**`CLAUDE.md` spans this tranche makes sheddable, measured 29 August 2026**, in
true bytes, each including its line's own newline, a deleted line taking it
along:

| Span | Line | Bytes |
| --- | --- | --- |
| §Conventions file-claim bullet | 50 | 500 B |
| §Conventions content-record sub-bullet | 51 | 2,243 B |
| §Conventions Bash-route bullet | 53 | 650 B |
| §Conventions denied-edit-debt bullet | 55 | 959 B |
| §Conventions release bullet | 56 | 1,307 B |
| §Conventions script-claims bullet | 57 | 265 B |
| **Total** | | **5,924 B** |

**This table is a pool, not a shed:** the 5,924 B is what the tranche made
retrievable. mantahostels#1498's approval gate binds the cut, which is §The shed
landed below.

**Drift against the ticket's opening figures**, which mantahostels#1646 recorded
when it was written, in characters as the ticket counted them: the Bash-route
(646), debt (951) and script-claims (265) spans are unmoved; the release bullet
has shrunk 1,390 → 1,301 and the file-claim rule has grown 2,340 → 2,719, both
to parallel sessions. Net **+290** against the ticket — 5,882 characters against
mantahostels#1646's 5,592.

**Out of scope and staying, deliberately:** the `request` bullet (line 52,
652 B) and the stale-script bullet (line 54, 525 B). Neither is in this
ticket's five, and both belong to clusters mantahostels#1762 has not yet aimed at.

### Cap headroom on the two triggers

`gp_rule`'s ceiling is **4,000 B** (`GP_RULE_CAP`), and this cluster is the
first to exceed it. Derived from `GP_RULE_CAP` and the fragment sizes above,
`gp_rule` filling in priority order and deferring whole ids;
`scripts/guard-file-claim.test.ts` asserts that every id arrives, not which
emission carries it:

| Trigger | Emission 1 | Emission 2 |
| --- | --- | --- |
| a write to the deny tier | `file-claim` — 2,351 B, 59% | `claim-release` + `claim-bash-route` + `denied-edit-debt` — 3,826 B, 96% |
| a write under `scripts/` | `script-self-claim` + `file-claim` — 2,816 B, 70% | `claim-release` + `claim-bash-route` + `denied-edit-debt` — 3,826 B, 96% |

**6,636 B is the cluster's total and 3,826 B its largest single injection** —
the figures mantahostels#1787's shared ratchet should read, the per-delivery cap
being 7,789 B (mantahostels#1720, mantahostels#1756). **Emission 2 sits at 96% of
the ceiling, so the next byte added to any of those three fragments splits it
into a third emission.**

**`denied-edit-debt` trails `claim-bash-route` on both triggers:** the
arbiter's refusal reprints the debt rule in full with the real path substituted,
while nothing anywhere reprints the Bash-route rule, so that one must not be the
id that falls off the end.

### Mutation tests, the claim cluster

Run 29 August 2026 — one operative clause deleted per
fragment, the keyed test confirmed red, then reversed with the inverse targeted
edit:

| Fragment | Clause deleted | Test that went red |
| --- | --- | --- |
| `file-claim` | the `scripts/` detect-only tier row | emits file-claim on a write to the deny tier |
| `file-claim` | the `release --force <path>` line | emits file-claim on a write to the deny tier |
| `claim-release` | the `release <path>` line | emits claim-release on a write to the deny tier |
| `denied-edit-debt` | the `debt own <path> <issue>` line | emits denied-edit-debt on a write to the deny tier |
| `claim-bash-route` | the *"file unrefused"* line | emits claim-bash-route on a write to the deny tier |
| `script-self-claim` | the opening imperative | emits script-self-claim on a write under `scripts/` |

Four further mutations were run against the GUARD rather than the store —
dropping each deny-tier id from its `gp_rule` call — and each turned the same
test red. That pair is what the store-reads-itself tautology needs: the
accessor assertion alone holds the wiring and nothing about the text, so each
case carries literal needles from its fragment's operative clauses as well.

## The shed landed — approved and cut the same day (mantahostels#1646)

The founder approved all five deletions on 29 August 2026, put individually per
mantahostels#1498. The spans and the shed:

| Span | Line | Before | After | Shed |
| --- | --- | --- | --- | --- |
| file-claim bullet + content-record sub-bullet | 50-51 | 2,743 B | 398 B | 2,345 B |
| Bash-route bullet | 53 | 650 B | 362 B | 288 B |
| denied-edit-debt bullet | 55 | 959 B | 335 B | 624 B |
| release bullet | 56 | 1,307 B | 383 B | 924 B |
| script-claims bullet | 57 | 265 B | 272 B | −7 B |
| **All five** | | **5,924 B** | **1,750 B** | **4,174 B** |

**70.5% of the cluster shed** — against §Tranche (mantahostels#1647)'s 63.8% on the same
route and §Tranche 3's 40.0% on the deny route, and above spec mantahostels#1762's assumed
52-70% band. `CLAUDE.md` **34,151 B → 29,977 B**; pool headroom **4,620 B →
8,794 B** (`node scripts/check-context-budget.js`).

**The script-claims bullet grew, by 7 B.** It was already at trigger-line length
before this tranche — 265 B, the smallest span in the register — and the
`rule:script-self-claim` pointer costs more than the prose it replaces. Kept
because the pointer is what stops the next session rewriting the rule in place;
recorded here so no later tranche reads it as a shed.

**Three of the five are `Unenforced`, which narrows mantahostels#1619.** That ruling let an
`Unenforced` rule keep its trailer in full *because nothing ever prints for it*.
Route (f) prints for it. The trailers here are cut to the status word, the issue
numbers and the guard — the treatment mantahostels#1619 reserved for deny-guards — because
the injection now supplies what the refusal supplies elsewhere. Recorded as a
narrowing, not a reversal: a rule with no guard at all still keeps its trailer.

**The pass rate now has two measurements on route (f), 63.8% and 70.5%**, on the
two clusters at opposite ends of the reprint spectrum — mantahostels#1647's rules were
already reprinted in full by a refusal, and four of these five had no refusal at
all. That the two land 7 points apart is the first evidence the rate does not
depend much on whether a refusal already carried the text.

Ledger entry: `docs/doc-map.md` §Capture and placement §5.

## Tranche — the pull and push cluster (mantahostels#1648, re-aimed to spec mantahostels#1762)

The pre-emptive route, not mantahostels#1641's deny route: the rules are stated on the
command that is about to run, through `gp_rule` (mantahostels#1804), and the refusal is a
second copy where a guard has one to give.

### The trigger audit, run behaviourally

All three rules were run as Claude Code runs them, across the two guards that carry them — hook JSON on stdin,
`CLAUDE_PROJECT_DIR` at a throwaway repo, `CLAUDE_CONFIG_DIR` and `TMPDIR`
redirected — and the real output read.

| Rule | Trigger | Fires? | Verdict |
| --- | --- | --- | --- |
| Fast-forward-only | `git pull --ff-only`, or a bare pull under `pull.ff=only` | yes, as an injection | printable-in-time |
| Fast-forward-only | `git pull --rebase` | yes, as a refusal | printable-in-time |
| Fast-forward-only | `git pull --help`, `git fetch` | silent | correctly out of scope |
| Fast-forward-only | `git rebase`/`git merge origin/main` after a fetch | no | unreachable — named inside the fragment instead |
| Push cadence | `git push`, in the shared tree or a linked worktree | yes, as an injection | printable-in-time |
| Push cadence | a push run outside Claude Code, or through `xargs`/`env`/`sudo` | no hook, or no first word to read | unreachable |
| Green suite | `git push` — same trigger, second id | yes, as an injection | printable-in-time |

**Neither push rule has a guard to refuse with**, the cadence being
**Unenforceable** (mantahostels#244, mantahostels#1098) and the green-suite warning **Unenforced**
(mantahostels#987). `scripts/guard-push-rules.sh` judges nothing at all: it emits
`additionalContext` and never a `permissionDecision`.

**The fast-forward rule's refusal route is proven by use as well as by
construction:** `scripts/guard-pull-form.sh` has fired **17** times
([docs/research/guard-fire-counts.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/guard-fire-counts.md), mantahostels#2140). The pre-emptive limb adds the
spelling this repo runs: `git pull --ff-only` reaches the injection every time and a refusal never.

### Bytes

| `CLAUDE.md` bullet | Before | After | Shed |
| --- | --- | --- | --- |
| Push cadence (L46) | 1,173 B | 473 B | 700 B |
| Green suite (L47) | 453 B | 271 B | 182 B |
| Fast-forward-only (L48) | 537 B | 331 B | 206 B |
| **All three** | **2,163 B** | **1,075 B** | **1,088 B — 50.3%** |

**Realised, not projected.** All three deletions were approved together and
landed in the same commit as their trigger lines, which is the only shape
`check-doc-map.js` accepts: trigger lines alone add pool bytes and are refused
without a §5 ledger entry. `CLAUDE.md` **29,977 B → 28,889 B**.

**50.3% is the lowest of the three route-(f) clusters, not the highest.** mantahostels#1647
realised 63.8% and mantahostels#1646 70.5% on this same route, and mantahostels#1762's comparable figure
is its 52–70% per-rule pass rate, which 50.3% sits under. (mantahostels#1762's 24–33% is the
yield over the whole of `CLAUDE.md`, not a cluster's shed rate; it is not the
band to compare against.) What holds this cluster down is the cadence bullet:
1,173 B, the second-longest in §Conventions, and much of it — the sweep times,
the mantahostels#386 cost measurement, the `post-commit` counter's behaviour — is context a
session acts on and so cannot be cut to a trigger line.

**Fragment bytes, outside both context caps and rationed by measurement alone:**
`push-cadence.txt` **1,058 B**, `push-green-suite.txt` **486 B** as emitted (this
section's convention, `wc -c` minus the trailing newline) — 1,546 B on the wire,
`gp_rule`'s `\n\n` separator restoring the two,
plus `pull-fast-forward.txt`'s 826 B already counted in §Tranche 3. Store size
after this tranche: **16,785 B on disk across fifteen fragments** (16,770 B as
emitted, both accessors trimming the trailing newline). Every figure in this
section is a true byte count — `len()` over the file's bytes, not `wc -m`.

**Cap headroom on `git push`.** The two ids emit 1,546 B against `gp_rule`'s
4,000-byte ceiling, leaving ~2,450 B for mantahostels#1805's §Gotchas ids on the same
trigger. The request is by id and never blanket, so a fragment added to the
store later cannot silently take that headroom.

### Prediction

Neither push rule has ever had a guard, so the fire counts start at zero and any
non-zero count in the week after is the injection working. The cadence rule
should fire in nearly every session that pushes — one per session, by the latch
— against `guard-pull-form.sh`'s fast-forward injection, which fires only in a
session that pulls, historically rare here. **Predicted: push injections
outnumber pull injections by more than 5:1 over the first week.**

**Verdict: it holds.** `guard-push-rules.sh` has fired **220** times against
`guard-pull-form.sh`'s **17** — **12.9:1**
([docs/research/guard-fire-counts.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/guard-fire-counts.md), mantahostels#2140).
No shed in this register reverses on it.

### Left for someone else

- *"Never force-push `main`"* (L49) is push-triggered and would fit this
  guard's injection, but it is no part of this ticket's three rules and its
  bytes are unmeasured here.
- `git fetch` is the one place the fast-forward rule's known residual — a
  `git rebase origin/main` after a fetch — could be reached pre-emptively. The
  guard walks `pull` alone, as mantahostels#245 scoped it.

## Tranche 5 — the killed-background-job rule onto route (f) (mantahostels#1904, under mantahostels#1900)

**Not a shed.** No pool byte moves: `CLAUDE.md` §Subagent dispatch keeps the
pointer left there, and this tranche adds the retrieval the pointer lacks rather
than paying for its removal. Tranche 6 cuts the pointer.

**Fragment bytes, outside both context caps and rationed by measurement alone:**
`killed-background-job.txt` **1,118 B on disk, 1,117 B as emitted** (`wc -c`
minus the trailing newline). Store size after this tranche: **17,847 B on disk
across sixteen fragments** (17,831 B as emitted). **Reconciliation:** the pull
and push cluster closed at 16,785 B across fifteen, and the same fifteen measure
16,729 B today — **56 B less**, moved by a parallel session between the two
readings and unattributed.

**Cap headroom on the trigger.** One id emits 1,117 B against `gp_rule`'s
4,000-byte ceiling, and route (f)'s per-delivery cap is 7,789 B
(`docs/doc-map.md` §Capture and placement §3). A backgrounded `git push`
also fires `guard-push-rules.sh` on the same `PreToolUse` event, so one delivery
can carry four ids — `push-cadence`, `push-green-suite`, `pull-fast-forward`
where it applies, and this one. `GP_RULE_CAP` is applied per guard, so
**nothing holds a multi-guard delivery under the 7,789 B per-delivery cap**:
the pair measures **2,607 B**, and the arithmetic is a session's to redo when a
fragment on either guard grows.

### Prediction

**Predicted: killed-background-job injections outnumber `push-cadence`
injections by more than 3:1 over the first week**, the latch making both one per
session and pushes being rarer than issue reads. The tranche after this one
writes the verdict (mantahostels#1719).

### Left for someone else

- The harness backgrounding a foreground call itself, after its 600 s timeout,
  sets no flag and so reaches no hook. mantahostels#1900 measured that route as the one that
  survived — but a session that gets there has been given no rule either.

## Tranche 6 — the killed-background-job pointer, taken (mantahostels#1928)

**Taken.** The founder ruled to cut the pointer the same day as Tranche 5.
`CLAUDE.md` §Subagent dispatch loses *"**A killed check ran nothing — re-issue
it (`scripts/bg-run.sh`).**"* — **70 B**, measured at the cut.

`CLAUDE.md` **28,889 B → 28,819 B**; pool headroom **9,882 B → 9,952 B**. Ledger
entry: `docs/doc-map.md` §Capture and placement §5, under mantahostels#1928.

**Route (f), not (e).** `scripts/guard-bg-job.sh` prints nothing on a refusal —
it never refuses. What pays for the cut is the pre-emptive injection on the flag,
which reaches strictly more sessions than the paragraph the pointer sat in.

### Left for someone else

- Register II is now spent past R21 with no verified candidate standing. The
  next tranche needing a shed has none, so **moving bytes onto route (f) is the
  only cheap direction left** — the observation mantahostels#1904 recorded in passing, still
  true and still nobody's ticket.

## Tranche — the §Gotchas cluster, pre-emptive limb (mantahostels#1805, spec mantahostels#1762)

The fourth tranche on **route (f)**, and the first to reach §Gotchas at all.

**The span table below is a pool, not a shed:** mantahostels#1498's approval
gate puts each deletion to the founder, and the cut is §The shed landed below.

### The trigger audit, run behaviourally

Every row is an assertion in
`scripts/guard-commit-form.test.ts`, `scripts/guard-push-rules.test.ts`,
`scripts/guard-check-sh.test.ts` or
`scripts/guard-suite-rule-injection.test.ts`.

| Bullet | Trigger | Guard sees it? | Verdict |
| --- | --- | --- | --- |
| Vercel builds every push | `git push` | yes — injects | printable-in-time |
| CI status lags your sha | `git push` | yes — injects | printable-in-time |
| doc-map runs in pre-commit | `git commit` naming a mapped-scope path | yes — injects | printable-in-time |
| digest version drift | `git commit` naming either roadmap file | yes — injects | printable-in-time |
| guard-registry gate | `git commit` naming a region document or a guard | yes — injects | printable-in-time |
| Biome reads staged paths only | `git commit` naming a file Biome parses | yes — injects | printable-in-time |
| superseded values | `git commit` naming a `docs/` path | yes — injects | printable-in-time |
| machinery superseded | `git commit` naming a `docs/` path | yes — injects | printable-in-time |
| red suite may be a neighbour's | `npm run test` / `test:changed` | yes — injects | printable-in-time |
| shellcheck is not from npm | `npm run check:sh`, `shellcheck` | yes — injects | printable-in-time |
| the `source=` directive | `npm run check:sh`, `shellcheck` | yes — injects | printable-in-time |

**Three bullets have no tool trigger and stay in `CLAUDE.md` regardless of
arithmetic**: manual freshness (591 B), the machine's
architecture (116 B) and the Singapore region ruling (612 B) — 1,319 B.

**One launch never reaches its rule.** `npm run test:watch` always draws the
watcher warning (mantahostels#1927), and `gp_warn` exits before the injection at the foot of
`scripts/guard-suite-concurrency.sh`. The rule is not spent — the session's next
one-shot run gets it — but a session that only ever opens watchers is never
told.

### Scoping, which is what makes the trigger affordable

`git commit` now carries seven ids against one 4,000-byte ceiling. Which of
them a session is handed turns on what the commit **names**, measured:

| Commit | Ids emitted | Bytes |
| --- | --- | --- |
| `-- a.md` (root Markdown) | commit-pathspec | 1,441 |
| `-- app/b.ts` | + biome-staged-gate | 2,108 |
| `-- scripts/c.sh` | + guard-registry-gate | 2,166 |
| `-- docs/a.md` | + doc-map-precommit, guard-registry-gate, superseded-values-gate, machinery-superseded | 3,480 |
| all five path kinds at once | five of seven; two deferred | 3,661 |

The widest commit **defers rather than truncates**: `superseded-values-gate` and
`machinery-superseded` do not fit, are left unlatched, and arrive whole on the
next commit.

**The scoping is an EXCLUSION, not a selection, and that is forced.**
`scripts/check-guard-registry.js` reads the LITERAL ids at a `gp_rule` call site
to decide which guard prints which fragment. Ids assembled into an array and
expanded would every one report UNPRINTED-RULE, and the store's third assertion
would stop meaning anything. So the call names all seven and
`gp_rule_skip` — a seventh name added to `scripts/lib/guard-parse.sh` for this —
takes out what the paths put out of scope. The alternative considered and
rejected was teaching the checker to read the array's own assignments: it works,
but it widens the gate to buy a call-site style.

### Bytes

**Fragments, which sit outside both caps and are rationed by measurement alone.**
Every figure is the **emitted** length — what `rule_text` returns, trailing
newline trimmed, which is `wc -c` minus one.

| Fragment | Bytes |
| --- | --- |
| `docs/agents/rules/suite-tree-dirty.txt` | 767 |
| `docs/agents/rules/guard-registry-gate.txt` | 723 |
| `docs/agents/rules/biome-staged-gate.txt` | 665 |
| `docs/agents/rules/doc-map-precommit.txt` | 486 |
| `docs/agents/rules/superseded-values-gate.txt` | 473 |
| `docs/agents/rules/shellcheck-not-installed.txt` | 436 |
| `docs/agents/rules/vercel-build-on-push.txt` | 425 |
| `docs/agents/rules/ci-status-lag.txt` | 420 |
| `docs/agents/rules/machinery-superseded.txt` | 349 |
| `docs/agents/rules/digest-version-drift.txt` | 338 |
| `docs/agents/rules/shellcheck-source-directive.txt` | 330 |
| **Total added to the store** | **5,412** |

**`CLAUDE.md` spans this tranche makes sheddable, measured 30 August 2026:**

| Span | Bytes |
| --- | --- |
| Vercel/`next build` bullet | 205 |
| CI-status-lag bullet | 267 |
| doc-map pre-commit bullet | 350 |
| neighbour's-half-written-file bullet | 711 |
| Biome staged-paths bullet | 737 |
| roadmap-digest version bullet | 274 |
| guard-registry bullet | 453 |
| superseded-values bullet | 411 |
| machinery-superseded bullet | 227 |
| shellcheck-not-installed bullet | 317 |
| `source=` directive bullet | 222 |
| **Total** | **4,174** |

**Reconciliation against the ticket.** mantahostels#1805 opened at **4,135 B** for the same
eleven bullets. The live figure is **4,174 B**, +39 B: `CLAUDE.md` moved between
the ticket being written and the work being done. The bullet set is unchanged —
eleven relocatable, three staying — and 4,174 + 1,319 = 5,493 B, the whole
§Gotchas body bar its heading, which is the check that nothing was miscounted.

**The store grows by more than `CLAUDE.md` would shrink** — 5,412 B against
4,174 B, +1,238 B. The store sits outside both context caps and is paid for once per firing; the
extra bytes are the escapes, the residuals and the "what this does not catch"
limbs a bullet in an always-loaded file could never afford.

### Cap headroom after this tranche

Emission figures are UTF-8 bytes (`len(ctx.encode())` on the payload), never
characters: `gp_rule`'s ceiling counts bytes, and every fragment is multibyte.

| Trigger | Ids | Widest emission | % of the 4,000 B ceiling |
| --- | --- | --- | --- |
| `git commit` | 7 | 3,661 B (two deferred) | 92% |
| `git push` | 4 | 2,339 B | 58% |
| `npm run test` | 1 | 767 B | 19% |
| `npm run check:sh` | 2 | 768 B | 19% |
| `git checkout`/`git worktree` | 1 | 1,342 B | 34% |

**`git commit` is now the contended trigger and has no room for a fifth
cluster.** mantahostels#1787's
shared ratchet should seed from the 3,661 B row.

### Left for someone else

- **The `git commit` trigger's priority order is a judgement, not a
  measurement.** It puts the gates that FAIL a commit locally ahead of the
  sweep-only WARNs, on the reasoning that a session loses more to the former.
  Nobody has measured which of the seven a session actually needed.
- **`npm run test:watch` reaches no rule**, above. Fixing it means letting an
  injection ride on a warn rather than deferring to it, which reverses mantahostels#1647's
  ruling and belongs on a ticket of its own.

## The shed landed — approved and cut the same day (mantahostels#1965)

All eleven §Gotchas bullets in §Tranche — the §Gotchas cluster were put to the
founder as eleven questions in **one round**, all outstanding at once, under
mantahostels#1498's standing rule, and came back on a single approval. The
eleven question texts and their per-bullet confidence figures are on
mantahostels#1965.

**The tranche's 4,174 B is a GROSS figure.** Each cut bullet leaves a `` `rule:<id>` `` trigger line behind. Measured
at the cut:

| Bullet | Gross | Trigger line | Net |
| --- | --- | --- | --- |
| `vercel-build-on-push` | 205 | 112 | 93 |
| `ci-status-lag` | 267 | 72 | 195 |
| `doc-map-precommit` | 350 | 119 | 231 |
| `suite-tree-dirty` | 711 | 103 | 608 |
| `biome-staged-gate` | 737 | 102 | 635 |
| `digest-version-drift` | 274 | 89 | 185 |
| `guard-registry-gate` | 453 | 120 | 333 |
| `superseded-values-gate` | 411 | 131 | 280 |
| `machinery-superseded` | 227 | 103 | 124 |
| `shellcheck-not-installed` | 317 | 112 | 205 |
| `shellcheck-source-directive` | 222 | 110 | 112 |
| **Total** | **4,174** | **1,173** | **3,001** |

**A twelfth edit the tranche did not foresee.** Three consecutive bullets opened
*"The same workflow runs …"*, whose antecedent — the bullet naming
`.github/workflows/roadmap-digest.yml` — was itself one of the eleven. Cutting
it left the surviving manual-freshness bullet pointing at nothing. Naming the
workflow in that bullet cost **+21 B**, so the booked figure is **−2,980 B**:
`CLAUDE.md` 28,817 B → 25,837 B, pool headroom 9,954 B → 12,934 B.
`docs/doc-map.md` §Capture and placement §5 carries the entry.

### Retrieval was already proved before the cut, for ten of the eleven

`node scripts/count-guard-fires.js` over 8,203 transcripts, read 30 August 2026
— every id below fired in the wild between mantahostels#1805 landing and this cut:

| Id | Fires | Guard |
| --- | --- | --- |
| `biome-staged-gate` | 18 | `guard-commit-form.sh` |
| `guard-registry-gate` | 10 | `guard-commit-form.sh` |
| `doc-map-precommit` | 9 | `guard-commit-form.sh` |
| `superseded-values-gate` | 9 | `guard-commit-form.sh` |
| `machinery-superseded` | 8 | `guard-commit-form.sh` |
| `vercel-build-on-push` | 8 | `guard-push-rules.sh` |
| `ci-status-lag` | 8 | `guard-push-rules.sh` |
| `suite-tree-dirty` | 7 | `guard-suite-concurrency.sh` |
| `shellcheck-not-installed` | 5 | `guard-check-sh.sh` |
| `shellcheck-source-directive` | 5 | `guard-check-sh.sh` |
| **`digest-version-drift`** | **0** | `guard-commit-form.sh` |

Ten of the eleven were ripe on the day of the cut, on mantahostels#1886's test: a
prediction ripens once its subject shows a `LAST FIRE` at or after the
prediction's date, one fire since being enough. `digest-version-drift`'s trigger
is a commit naming `docs/reference-roadmap.html` or `docs/roadmap-digest.md`;
the trigger audit above proved it *injects* when driven, and nothing yet shows a
real session reaching it.

**The eleven trigger lines sit outside any guard-registry region**, as does
`killed-background-job`'s from mantahostels#1928's cut, and no check warns on
that: `scripts/check-guard-registry.js` has no ORPHAN-FRAGMENT warning
(mantahostels#1992, mantahostels#2006). UNPRINTED-RULE FAILs on any fragment no
wired emitter prints, and a rule relocated fully onto a guard that hands it over
pre-emptively has no trigger line by construction. A figure this file records
is measured in a worktree, never in the shared tree.

## R16 taken — 1 September 2026 (mantahostels#2358)

**R16 is spent.** `CLAUDE.md` §Agent skills lost *"`grep -Rl 'disable-model-invocation: true' .claude/skills/*/SKILL.md` names the set (`-R`: 24 are symlinks)."* — **109 B**.

It paid a **falsity correction**, which takes first claim on this register (mantahostels#1221): the two `CLAUDE.md` guard-registry markers at mantahostels#1555 and mantahostels#1200 read as unlimited enforcement where both guards stop after **3 blocks a session**. The first commit is net **−41 B** on the pool — 68 B of qualification against the 109 B cut, `CLAUDE.md` 29,832 B → 29,791 B — so it opened 66 B of headroom and closed 107 B. A second commit spent 34 B saying the guard's three blocks are shared rather than one allowance per rule, so **the tranche's figure is −7 B** and the pool closes at **73 B**.

**What stays, and why:** the *"15 of the 35 skills"* count in the same bullet, on this register's own §Examined and refused verdict — it is what makes the bullet credible without running anything, and the flag it names is enough for a session to write the grep back.

**The register is now spent for `CLAUDE.md` and `AGENTS.md` alike.** R1–R15 and R17–R21 were all taken across Tranches 3-5 and their successors, and R16 was the last live entry. **A later falsity correction has no standing candidate to claim** and fires the unpayable-correction trigger (`docs/doc-map.md` §Capture and placement §4) unless a fresh register is built first.

**The shed reverses a `docs/doc-map.md` §Capture and placement §5 named residual.** mantahostels#1629's ledger entry refuses R16 outright: *"the sentence above it names the flag but not `.agents/skills/`, so a session writing that grep unaided gets a wrong answer with nothing signalling it."* That refusal is obsolete on its own terms — the surviving sentence names `.claude/skills/`, which is the right directory.

**The `-R` in the cut clause was inert.** `grep -l` and `grep -Rl` over `.claude/skills/*/SKILL.md` both return 15, the shell glob already expanding through the 24 symlinked directories. A later session must not restore it.

---

# Register III — 1 September 2026 (mantahostels#2375)

**Ticket:** mantahostels#2375 (build a fresh register). Register II (R1–R21) and the original C1–C11 list are both fully spent — every span taken, none survives in `CLAUDE.md` or `AGENTS.md` today. This section is a fresh end-to-end walk of the four always-loaded files, ids **G1–G7** so they never collide with C- or R-ids above.

**Measured at the time of writing** (`node scripts/check-context-budget.js`): `CLAUDE.md` 29,815 B · `AGENTS.md` 6,236 B · `docs/working-contract.md` 567 B · `.claude/output-styles/manta-voice.md` 4,760 B, counted twice (mantahostels#1503) · own skill and command descriptions 779 B = pool **46.9 KB of 47.0 KB, 83 B headroom**. Re-measure before cutting — the pool moves within a day.

**Method**: for each span, apply `docs/doc-map.md` §Capture and placement §3's test — is it a rule; name the trigger (no nameable trigger is pool-only, not a candidate here); needed to choose or only to be stopped (route (f) vs (e)); reach; and Register II's in-time test (*"printable-in-time"*). Every route-(e)/(f) claim below was checked **behaviourally** (mantahostels#886) — the guard or checker's own source read, and its literal output quoted, never matched on topic. G1's reprint lands when a filtered run or push actually happens, and G6's when a request is actually issued: both are route (e)'s *"needed only to be stopped"* case (§3 step 3), where a late reprint loses nothing, unlike the background/end-turn rule at mantahostels#964, which had to arrive before two wasted polls. Building the register cuts nothing; each span goes to the founder individually in a later tranche, as Register II's did.

**Two forks split the walk**: `CLAUDE.md` (by far the largest file, and the only one carrying live guard-registry regions) against `AGENTS.md`, `docs/working-contract.md` and `.claude/output-styles/manta-voice.md` together. A third pass verified five CLAUDE.md leads the first fork flagged but did not itself check.

## AGENTS.md, docs/working-contract.md, .claude/output-styles/manta-voice.md — one candidate

**G7 · `AGENTS.md` §New dependencies, the verify-before-adding bullet — L26, span 275 B, net ≈180 B (est.)**

`scripts/guard-npm-install.sh`'s five deny branches (L355–395) were read in full; three reprint the bullet's substance. `thin:*` prints, verbatim: *"`AGENTS.md` §New dependencies asks for real download history. This has none, which is what a squatted name looks like from the outside."* — citing the bullet by section name. The `missing` branch covers *"verify it actually exists on npm"* and the *"active attack vector"* framing (paraphrased, not verbatim). The unreachable-registry branch (`*`) prints *"An unchecked install is what `AGENTS.md` §New dependencies exists to prevent"* — the same purpose the bullet states as *"Do not install a package on your own say-so."*

**Residual:** *"active maintenance"* is not mentioned by any of the five deny branches and stays.

**Nothing else.** §Business invariants' OTA bullets are pinned (§B15, §B36) and untouched. `AGENTS.md`'s *"Always commit the lockfile."* (29 B) is reprinted by `scripts/guard-npm-install.sh`'s deny on one path only (a missing `--ignore-scripts`) — not on a clean install or a version-bump lockfile change, so the behavioural test fails for most of the bullet's real trigger; refused. `scripts/guard-claimed-bash-write.sh` (new since mantahostels#1818) was checked against the mutation-reversal `cp`/`restore`/`stash` clause and found Tier-1-only and claim-specific — it does not reach the general destroys-uncommitted-work warning, so Register II's refusal of that clause still holds. `docs/working-contract.md`'s three bullets are re-confirmed untriggered — no tool call fires before a reply is written, which is when every one of them binds. `.claude/output-styles/manta-voice.md`'s own content stays out of this map's scope (sibling map mantahostels#1496 owns it); its `@`-import double-load is confirmed still deliberate (mantahostels#1503, mantahostels#1504).

## CLAUDE.md — confirmed route-(e) candidates

**G1 · §Conventions, the `test:changed` bullet's lexical-extractor clauses — CLAUDE.md L48, span 1,570 B, net ≈550–650 B (est.)**

Three separate guards reprint the operative content at the moment of need. `scripts/run-vitest.js`'s `admissibleLine` (L698–707) prints, on a filtered green: *"MEETS THE PUSH GATE — docs/test-read-edges.json matches this tree, so a green here is the whole gate: no whole-suite run is owed (mantahostels#2207) … It does not cover a test that reads a changed document through an imported HELPER — the manifest's extractor is lexical, so there is no edge to select on and this check cannot see one missing (mantahostels#2131)."* The same lexical-extractor caveat is reprinted a second time at push, by `scripts/lib/test-pass-marker.js`'s `admissibleScopeWarning()` (L735–750). `scripts/generate-test-read-edges.js` L138–141 prints the dirty-read warning on an uncommitted source file, confirming the *"warns (not refuses) … uncommitted at write time"* clause.

**Residual, not printed anywhere:** *"only to an argv holding nothing but `--changed` and its ref; nothing refuses a push backed by one"* (a fact about `guard-push-rules.sh`'s own scope) and *"an edit landing and reverting between two writes, dirty at neither, stays unseen"* (reasoning about the warning, not stated by it) both stay. The bullet sits inside `CLAUDE.md`'s guard-registry region, so a cut needs its own `rule:<id>` trigger line kept per the Method note's convention — left for whoever drafts the cut.

**G2 · §Conventions, the `--no-verify` bullet's enforcement-mechanism sentence — CLAUDE.md L45, span 1,360 B (whole bullet), net ≈230 B**

`scripts/guard-commit-form.sh`'s `deny_no_verify()` (L282–296) prints, verbatim, the same five subcommands and the same three tickets as the bullet's *"Enforced (mantahostels#1705, mantahostels#1706, mantahostels#1707) …"* sentence, on any `--no-verify`/`-n` attempt.

**Residual, load-bearing:** the bullet's *opening* clause — what a cherry-pick/rebase/revert replay runs while **not** passing `--no-verify` — is confirmed by `guard-commit-form.sh`'s own header comment (L70–74) to be true but is never printed to a session: *"EVERY VERDICT BUT `--no-verify` is suppressed while a merge, rebase, cherry-pick, revert or am is in progress,"* by design, silently. This is the opposite of route (e) and stays. The *"Three defeats remain"* escape-route paragraph also stays for the identical reason — each defeat bypasses the hook entirely, so by construction nothing can warn about it at the moment of use.

**G3 · §Conventions, the sweep-fire budget bullet — CLAUDE.md L68, span 602 B, net ≈300 B (est.)**

`scripts/guard-sweep-fire.sh`'s deny (L195) prints, close to verbatim: *"…counting BOTH the automatic fires check-ci-status.js makes when a verdict goes stale and hand-fired ones like this — they share one counter (mantahostels#2202), so six of either or any mix exhausts the day … four routes fire a sweep without passing here at all: the GitHub web UI, `gh api … /dispatches`, a fire from inside a script, and the founder's own terminal."*

**Residual:** *"the `.sweep-autofire` marker in the git common dir, which worktrees share"* — the counter's storage mechanism — and *"no exemption for repairing a missed slot"*, which lives only in a source comment (L18–20), are not printed by the deny and stay.

**G4 · §Conventions, the wait-loop ceiling bullet — CLAUDE.md L55, span 505 B, net ≈410 B (est.)**

`scripts/guard-wait-loop.sh`'s warn (L119–127) reprints nearly the whole bullet: *"This wait loop has no ceiling … It outlives the session that wrote it, reparents to init, and goes on holding a slot after the session reads as Completed … Bound it, either way: `timeout 600 bash -c 'until <condition>; do sleep 10; done'` / `n=0; until [ $n -ge 36 ] || <condition>; do sleep 20; n=$((n+1)); done` … What this guard cannot see: it reads a ceiling as a `timeout`, or a numeric comparison in the condition with a counter in the body. One spelled any other way … reads as no ceiling at all."*

**Residual:** *"a loop started outside the Bash tool is never seen"* is not printed by the warn (the guard only fires on a Bash-tool call by construction) and stays.

**G5 · §Gotchas, the orphan-wait-loops bullet — CLAUDE.md L88, span 365 B, net ≈175 B (est.)**

`scripts/check-orphan-wait-loops.js` (`ORPHAN_AFTER_MINUTES = 30`, L76) prints on every session start where one is found: *"ORPHAN-WAIT-LOOP (N) — a wait loop whose session is gone, over 30m: pid X, age, argv, `kill X` … Nothing was killed, and this sweep has no way to kill anything."*

**Residual:** *"It sees no loop your own shell still parents, and degrades to silence with no `/proc` — a clean session start is not proof"* is never printed — the guard's own skip conditions (`mine.has(proc.pid)`, an unreadable `/proc`) are silent by design, the same shape §Examined and refused's `node_modules`/`npx` entry already established. Stays.

**G6 · §Conventions, the request-a-held-file bullet's mechanism sentences — CLAUDE.md L52, span 655 B, net ≈380 B (est.)**

`scripts/session-arbiter.js`'s `cmdRequest()` (L1931–1981) prints, on a successful request: *"Requested <rel> from session <holder>. The holder is NOT woken — it is told at its own next write to the file, or its release of it, and otherwise never. A request is a courtesy, not a wait: carry on with the rest of your ticket, and record the blocked edit as a debt exactly as before. See whether it has been answered: `node scripts/session-arbiter.js requests`."*

**Residual, not printed by `cmdRequest`:** the hourly-dedup mechanism — *"once, and at most once an hour thereafter, the marker that dedupes it being swept hourly, so a repeat is not a second request"* — and the `decline` command's existence and syntax (`cmdRequests()`, L1989–2028, only ever shows a request already declined; it never teaches a first-time requester that `decline <path> "<reason>"` exists). The **Unenforced** (mantahostels#1702) marker also stays, per the guard-registry convention.

## CLAUDE.md — examined and refused, this pass

- **§Conventions, branch rule, the text added since mantahostels#1648** (recipe/escape/second-limb framing around the `Enforced (mantahostels#110, mantahostels#1648)` trailer). `scripts/guard-branch.sh` read again in full: nothing beyond what Register II already covered (R3, and the `node_modules`/`npx` clause, both refused there) has landed. The trailer sentence is a meta-description of what the guard's deny does, not content the guard itself reprints, so it is not a candidate on its own. No new bytes.
- **§Ground truth, doc-map read-order and §B-entry obligation sub-bullets** (L20, L22, 1,067 B + 665 B) — flagged by the first fork as leads, not walked to a verdict this pass. The §B-entry sub-bullet in particular reads as pool-only on inspection: whether a fact is load-bearing is a judgement call, not a tool call, so §3 step 2 names no trigger.
- **§Conventions, claimed-bash-write bullet** (L53, 671 B) — the bullet's own text already states *"nothing reprints this one"* (`rule:claim-bash-route`'s residual), which is a strong self-disqualifying signal; not walked further this pass.
- Four further leads, byte-ranked, flagged but not walked to a verdict this pass:

| Bullet (opening clause) | File·L | B | Guard/checker to read |
| --- | --- | --- | --- |
| §Conventions, turn-ends rule | L69 | 532 | `scripts/guard-uncommitted-work.js` — likely mostly justified already (R1's residual carved out the progress-report limb as uncovered) |
| §Conventions, stale-script | L54 | 525 | `scripts/guard-stale-script.sh` + `warn-stale-script.js` — Register I's C5 already took the verbatim strings; check only for text added since |
| §Conventions, solo-project | L37 | 514 | no guard known — likely pool-only, no nameable trigger |
| §Machine limits, suite concurrency | L99 | 322 | `scripts/guard-suite-concurrency.sh` — the free-m thresholds are acted-on thresholds per the old Rejected table's C7 residual; likely mostly refused already |

## Totals, Register III

| Class | Ids | Span B | Net B (confirmed/est.) |
| --- | --- | --- | --- |
| Confirmed route (e), `test:changed`/`--no-verify` | G1–G2 | 2,930 | ≈780–880 |
| Confirmed route (e), Conventions/Gotchas quartet | G3–G6 | 2,127 | ≈1,265 |
| Confirmed route (e), `AGENTS.md` §New dependencies | G7 | 275 | ≈180 |
| **Total confirmed** | G1–G7 | **5,332** | **≈2,225–2,325** |
| Zero-yield (working-contract.md, manta-voice.md) | — | — | 0 |
| Unverified leads, not claimed | 4 spans | 1,893 | — |
| Examined, no new bytes (branch-rule delta) | — | — | 0 |

**This register is not spent**: it holds a shed candidate for whatever falsity correction reaches for it next.

**Left for the landing session:** draft the precise cut text for whichever of G1–G7 is taken, keeping each bullet's named residual and its single `rule:<id>`/`Enforced` marker (`check-guard-registry.js`'s requirement), then re-measure and record the tranche in `docs/doc-map.md` §Capture and placement §5 per the ledger's own discipline (trigger verdict, prediction, named residual).

## G4 and G5 taken — 4 September 2026 (mantahostels#2869)

Both spans were cut to pay for `CLAUDE.md`'s guard-registry line for the
retro-edit gate (mantahostels#2869). Each
route-(e) claim was re-checked behaviourally on the day, against the guard's own
source rather than against this register's write-up:

- **G4** — `scripts/guard-wait-loop.sh:119-127` prints the outlives-and-reparents
  consequence, both recipes and the two-part ceiling test, close to verbatim.
  Cut. The residual this register named — *"a loop started outside the Bash tool
  is never seen"* — stays in the bullet, as it said it must.
- **G5** — `scripts/check-orphan-wait-loops.js:289` prints the per-pid `kill` and
  `:320` prints *"Nothing was killed, and this sweep has no way to kill
  anything."* Cut, the 30-minute figure with it. Its residual — that the sweep
  sees no loop your own shell still parents and degrades to silence with no
  `/proc` — stays.

**The net figure was over-estimated, and that is the finding.** This register
priced G4 alone at ≈410 B net. The two spans together bought **218 B**, so G4
alone would not have paid for a 271 B entry and a second span had to be taken
mid-ticket. Price a span by cutting it and measuring, never off the estimate in
the table above.

**Register III now holds G1, G2, G3, G6 and G7**, and the pool closed at **15 B**
headroom — so the next tranche of any size needs one of them.

## G3 taken — 6 September 2026 (mantahostels#3128)

Cut on route (e): the bullet's operative text is now
`docs/agents/rules/sweep-fire-budget.txt`, a hand-written fragment
`scripts/guard-sweep-fire.sh` splices into its deny, and the bullet keeps a trigger line citing `rule:sweep-fire-budget`. Both residuals
this register named — the `.sweep-autofire` marker's location, and the
missed-slot clause added from code review — went into the fragment AND stayed
in the bullet, on mantahostels#3128's instruction.

**The span bought 136 B against the ≈300 B estimate**: the estimate priced the
whole duplicated run, and the two kept residuals plus the `rule:` citation eat
about half of it. The pool closed at **184 B** headroom.

**Register III now holds G1, G2, G6 and G7.**

## G1, G2 and G6 taken, in part — 28 September 2026 (#597)

Cut to pay for `.claude/output-styles/core-voice.md`'s guard-registry line for
the founder-act refusal (353 B, paid twice, mantahostels#1503). Each is route (e):

- **G1** — `scripts/generate-test-read-edges.js:360-366` warns on stderr, on
  every write, that a file the render used is uncommitted and may be a
  neighbour's in-progress edit, and says to re-run once the tree is still. The
  `68c7c548` incident narrative and the over- and under-population restatement
  were cut; the gap, `--check`'s blindness to it and the land-and-revert
  residual stay. **439 B.**
- **G2** — `scripts/guard-commit-form.sh:405` names, per subcommand, which hook
  `--no-verify` would skip. The sentence keeps its tickets and its three
  enforcing files, not the per-subcommand list. **129 B.**
- **G6** — `scripts/session-arbiter.js:2489` prints *"A request is a courtesy,
  not a wait: carry on with the rest of your ticket, and record the blocked
  edit as a debt"* on every `request`. That sentence was cut; the hourly
  dedupe and the `decline` read-back, printed nowhere, stay. **130 B.**

**702 B in all** (CLAUDE.md 32,479 B → 31,777 B; the per-span figures count
characters), and the pool closed at **6 B** headroom (`node scripts/check-context-budget.js`).
The G2 and G6 residuals this register named are unchanged, so **Register III
holds only G7**, whose `AGENTS.md` bullet stands uncut.

## The pull rule's pass list taken — 28 September 2026 (#598)

Cut to pay for the founder hand-over registry line's growth in
`.claude/output-styles/core-voice.md` (353 B → 402 B, paid twice,
mantahostels#1503), which now covers the actor-only refusal too. Route (e):
`docs/agents/rules/pull-fast-forward.txt:29` names the passing forms, and
`scripts/guard-pull-form.sh` prints that fragment on every merge, rebase or
pull, refused or not. CLAUDE.md's *"`git merge --ff-only` passes, and so do
`--abort`, `--continue`, `--quit` and `--skip`, which unwind rather than start
one."* was cut whole. **124 B**, and the pool closed at **37 B** headroom
(`node scripts/check-context-budget.js`).
