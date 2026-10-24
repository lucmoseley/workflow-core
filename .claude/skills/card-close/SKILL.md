---
name: card-close
argument-hint: <issue-number>
allowed-tools: Bash(gh:*), Bash(git:*), Bash(node:*), Read, Edit, Skill
---

Close GitHub issue **#$ARGUMENTS** and record its roadmap card as `done`, as one operation.

The roadmap is the sole authority for card state; the issue is the working surface.

**Do not restate or re-derive the roadmap edit loop.** Step 4 hands off to the `roadmap-edit` skill, which owns it.

## One refusal here is backstopped; the rest are prose

There are three stops: an unresolvable card id (step 2),
a validator ERROR or a non-empty added/removed card list (step 5), and a digest
stamp mismatch (step 6). Nothing in this file exits non-zero on its own, so all
three are **instructions to a model, not shell guards**. Half of one has a
backstop further down the line; the other two and a half have none.

**Backstopped — step 5's ERROR half.** `${CLAUDE_PLUGIN_ROOT}/scripts/check-roadmap-valid.js` runs in
`.husky/pre-commit` on any commit staging `docs/reference-roadmap.html`, so
step 7's commit is refused outright even if this file's stop was ignored (mantahostels#698).
Routes that hook never sees. A `--no-verify` commit typed in the founder's own
terminal — `${CLAUDE_PLUGIN_ROOT}/scripts/guard-commit-form.sh` denies that flag to an agent
session, on `git commit` alone (mantahostels#975). And `git cherry-pick`, `git revert`, `git rebase`
and `git am`, which run no commit gate at all (measured at mantahostels#1679). An
auto-resolving merge is not among them: `.husky/pre-merge-commit` gates it (mantahostels#1679).
All are caught instead by the scheduled `Document guards` job, which re-runs the
same checker in `--tree` mode (mantahostels#974). It never substitutes for
the commit gate.

**One finding neither this file's step 5 nor tree mode ever shows you:
`PHASE-BOUNDARY`** (mantahostels#1130). Closing a `validate-pN` card crosses a phase
boundary, which re-opens the agent-spend ladder — but step 5 runs the skill's
`validate.js`, which does not carry the check, and tree mode has no baseline to
compare against. It reaches you only as step 7's pre-commit stderr, and it asks
for work *after* the commit: read the ladder (`docs/capacity-procurement-ladder.md`,
or `capacityLadderPath` in `.claude/workflow-core.json` where declared)
§Re-assessment and add a dated line to its log. Relay it rather than reading a
successful commit as the end.

**Prose — step 5's scope half.** The added/removed card list refuses *here*
because this skill only ever changes an existing card. The commit gate
deliberately reports that list rather than gating on it: a `roadmap-edit` run
that adds a card is ordinary work.

**Prose — steps 1, 2 and 6**, in full: each is a judgement you make this run
(mantahostels#656 asks whether they should become real exit-code guards).

**The frequency argument for guarding the prose stops is absent, and mantahostels#692's
commit-time gate rests on exposure rather than on observed breach — do not
re-argue it from these counts.** Replaying the roadmap's whole commit history
(derived 19 August 2026 at mantahostels#696): **1 validator ERROR in 173 roadmap
commits** — `0d79787e`, 7 July 2026, a card flipped to `done` with no log, three
weeks before this skill existed; **0 digest-stamp mismatches** across the 155
commits carrying both files; and **0 breaches across all 6 real `/card-close`
runs**. Five commits predate the validator, which arrived 4 July 2026.

⚠ **Replaying with today's validator flags 14 commits, and 13 are anachronisms**
— 9 fail only the ordering check that was dead code until `79dad1e`, and 4 (1–4
July) predate the validator entirely, failing only its callout-label rule. The
14th is the genuine ERROR above. ⚠ **The denominators move; the breach counts are
the figure** — 169 commits at mantahostels#692's run, 173 two days later. Read 1 / 0 / 0,
never the totals. **Re-running it:** `git log --follow` is load-bearing (40
commits predate the 23 July 2026 rename and a current-path-only scan drops them
silently), and each commit is validated by the **contemporaneous** validator, not
today's.

## Order is load-bearing

The roadmap goes first and the issue closes last, so a validation failure leaves the issue untouched. Never reorder these.

### 1. Preflight — wait or abort before touching anything

```bash
git status --porcelain docs/reference-roadmap.html   # empty, or poll below
gh issue view $ARGUMENTS --json number,title,state,body,comments
```

- Roadmap working copy dirty → **poll and retry; this is not a stop and never an escalation to the founder** (mantahostels#1074). Run the `roadmap-edit` skill's step 1 poll-and-claim loop, which owns the recipe, and on its non-zero exit register the debt against this issue and report the card left unmarked: `node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js debt own docs/reference-roadmap.html $ARGUMENTS "<card-id>: close log"`.
- Issue not found, or already `CLOSED` → **stop.** Report which.

### 2. Resolve the card id

Issue titles follow `<card-id> — <title>` (em dash). Take the prefix, then verify it names exactly one card:

```bash
grep -c 'id:"<card-id>"' docs/reference-roadmap.html   # MUST be exactly 1
```

Title doesn't parse, or the count isn't 1 → **stop and ask the founder which card this issue closes.** Never guess, and never fall back to fuzzy-matching the title against card titles.

### 3. Write the done-log, and name the judgement calls it makes

Gather the facts first: the issue number and title, the card id resolved in step 2, and the titles of any wayfinder child tickets, open and closed.

Then **write the log** — the session that has read the whole ticket holds synthesis the founder does not — and carry straight on to step 4. **Do not stop for an answer** (mantahostels#292, mantahostels#144, mantahostels#96).

**The log is not a transcript — it is a forward-pointing action guide.** Write what the next reader should do.

**Then name, in the report, every judgement call the log makes** — each with the framing chosen and the one rejected, so the founder can overrule any of them by name after the fact. The skill has already run at that point; an overrule is a follow-up edit, which is cheaper than the round-trip it replaces.

Done when the log names an action to take, and every judgement call it made is listed with its rejected alternative.

**Then write the closure back to any source document that declared this work open in its own words** — a gap ledger, a `Disposition: worth a ticket` row, a "no card covers this" line, a "parked — revisit as a card" note. `docs/adr/0006-disposal-writes-back-to-source.md` rules it: an editable source has its declaring line edited in place or deleted, a `derived` or `generated-only` one is written back at its generator's input, never by hand, a declaration that is an aged sidecar marker (`docs/doc-map-classes.json` `role`) is cleared there, and a file that merely mentions the area takes nothing. Grep the card slug and the work's own words for the declaration; where none exists, nothing is owed. Carry whatever you edit into step 7's pathspec.

### 4. Roadmap edit — via the `roadmap-edit` skill

Invoke the skill and follow its loop. Supply it:

- card id from step 2 → set `state:"done"`
- the founder's text, verbatim, as `log`
- MINOR version bump
- the timestamp, **in WITA (UTC+8), not the container clock**: `TZ=Asia/Makassar date '+%-d %B %Y, %H:%M'`

Also apply the skill's own discipline check: re-read the card's `b` and `mn` for prose that now contradicts `done`. `mn` is the one that goes stale — it's written once at card creation and rarely revisited, so a `done` card often still carries a model-note describing work as upcoming.

### 5. Validate — this is the refusal point

Take the baseline snapshot first. It is **skill-owned and HEAD-derived**: this skill creates it, at its own gitignored, **session-scoped** in-repo path, immediately before validating. The session id keeps two parallel runs from overwriting and deleting each other's snapshot; `CLAUDE_CODE_SESSION_ID` is in every `Bash` call's environment, so use it inline rather than via a shell variable that will not survive to the next call. Do not substitute the `roadmap-edit` skill's baseline and do not assume any snapshot already exists — step 4's skill writes its own, but relying on that couples this skill's refusal to another file's step ordering.

```bash
mkdir -p .claude/tmp/markers && git show HEAD:docs/reference-roadmap.html \
  > ".claude/tmp/markers/.card-close-baseline-$CLAUDE_CODE_SESSION_ID.html" || exit 1
node ${CLAUDE_PLUGIN_ROOT}/.claude/skills/roadmap-edit/scripts/validate.js docs/reference-roadmap.html \
  --original ".claude/tmp/markers/.card-close-baseline-$CLAUDE_CODE_SESSION_ID.html"
```

`git show` failing is a **hard stop**, not a warning — a baseline that could not be created means the scope diff below is unverifiable. Report the git error and stop. `validate.js` backs this up: a supplied-but-unreadable `--original` is a fatal ERROR, so a lost baseline cannot pass as a clean run.

HEAD is still the pre-edit roadmap at this point: step 1 refuses to start unless the roadmap working copy is clean, and the commit doesn't happen until step 7. Never move this snapshot after step 7.

Any ERROR, or a non-empty added/removed id list (this skill only changes a card, never adds or removes one) → **stop. Do not commit. Do not close the issue.** Report the validator output verbatim and leave the working copy in place for inspection.

`SCHEMA DRIFT` / `VERSION TRIPWIRE` warnings are not noise — handle them per the skill before continuing.

Then call the Skill tool with "concision-pass" against the baseline, before the digest, so the pruned text is what gets committed. Its pass marker records this session's start sha, not the baseline.

### 6. Digest

```bash
node ${CLAUDE_PLUGIN_ROOT}/.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js docs/reference-roadmap.html \
  --out docs/roadmap-digest.md
```

Then assert the version stamp in `docs/roadmap-digest.md` matches the one in `docs/reference-roadmap.html`. Mismatch → **stop**; a half-updated pair is exactly what `check-digest-version.js` exists to catch.

### 7. Commit both files together

```bash
git commit -m "<what closing <card-id> changed> (vX.YY)" \
  -- docs/reference-roadmap.html docs/roadmap-digest.md
```

Add any source document step 3's write-back edited to that pathspec.

**Commit by pathspec, never `git add` first** — the index is repo-global, and a parallel session's commit lands in the gap between staging and committing, carrying your files under its message (`${CLAUDE_PLUGIN_ROOT}/.claude/skills/roadmap-edit/SKILL.md` step 8).

Then push, per `CLAUDE.md` §Conventions. No gate runs on push (mantahostels#910): the suite and the document guards run four times a day from `.github/workflows/scheduled-checks.yml`, so a pushed commit stays unverified until the next sweep — up to ~12 hours, not the 6 the cron asks for, because GitHub delivers the slots late (mantahostels#2204). **You can shorten that wait**: `gh workflow run scheduled-checks.yml` fires one now, ~15.78 billed minutes at \$0.006/min ≈ \$0.095 — unless an earlier sweep already took this sha green, in which case mantahostels#3502's gate skips the suite and it bills ~2.06. `npm run check:ci` names the last sweep that carried a verdict and how far ahead of it HEAD sits.

The commit gives back this session's claims on the pair, the two most contended files in the repo, and prints `Released …` (workflow-core#2058). Where it names only one — a partial commit left the other dirty — commit the rest, or release by hand once it is clean: `node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js release <path>`.

### 8. Only now, close the issue — and say what is still outstanding

`${CLAUDE_PLUGIN_ROOT}/scripts/guard-issue-close.sh` denies a `gh issue close` unless the close's own `--comment`, or else the issue's newest comment, carries an `**Outstanding:**` line in its grammar (mantahostels#185, workflow-core#984). No earlier step here posts one, so without this line the skill's own last step is refused (mantahostels#281).

```bash
gh issue close $ARGUMENTS --comment "Closed via /card-close — roadmap updated in <commit-sha>.

**Outstanding:** none"
```

**`none` is a decision, not a default** — the same as `<commit-sha>` beside it. Where anything is left, replace it with the items, each citing an open issue: `**Outstanding:** #181 (log rotation), #182 (bare-commit warn)`. Nothing else goes on that line. The guard checks the shape and that each cited issue is open and not this one, never whether `none` is true, so it is an assertion this session makes rather than a phrase it pastes. File anything left first.

**No backticks in that comment.** Bash runs a command substitution on them inside double quotes and the word disappears silently.

## If step 8 fails

Say this plainly, without softening it:

> The roadmap is committed but the issue is still open. This skill cannot be atomic — git and GitHub can't commit together, so "must not half-commit" is not something it can guarantee. What it guarantees is the *direction* of failure: the roadmap is authoritative, so a stale-open issue is the cheap error and re-running `gh issue close <n>` fixes it. The reverse — a closed issue with no roadmap record — is the drift this skill exists to prevent, and cannot happen by construction.

Then give the exact `gh issue close` command to re-run, **carrying the step-8 Outstanding line** — the guard denies the re-run without it, and this is the one path that failure actually lands on.

## Report

No postamble: roadmap version + card id, validator pass line, commit SHA, issue closed, and step 3's judgement calls.
