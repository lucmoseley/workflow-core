---
name: retire-to-roadmap
description: "Closes a set of open issues after writing what each one asks onto the roadmap card that will fire it."
disable-model-invocation: true
---

# retire-to-roadmap

Closes a set of open issues by writing what each one asks onto the roadmap card
that will fire it, so the question survives the close and is re-filed when the
founder takes that card.

**Founder-invoked only.** A session never decides on its own authority that a
ticket should stop existing — that is the founder's call about his own backlog.

Prior runs, for worked examples: mantahostels#1048 (issues gated on an unfired event) and
mantahostels#1613 (issues opened against uncalled Phase-1 cards).

## What qualifies

Two classes, and nothing else:

1. **Phase-inappropriate** — the issue makes one of the adopter's product,
   business, catalogue or legal decisions for a card outside Phase 0 that the founder has
   not called. `docs/called-cards.md` is the register of called cards.
2. **Gated on an unfired event** — the issue's own body says it waits on
   something that has not happened: a surface existing, a regulation being
   enacted, a first published review.

**Repo machinery is exempt, always.** A ticket improving file structure, token
burn, guards, the doc map, the tracker or the test suite is workflow work the
founder wants continuing regardless of phase. The test is what the issue
*decides*, not which card it mentions.

## What to leave alone

- **A map that is nearly finished.** Retiring costs more than completing. In the
  mantahostels#1613 run this spared `taglines` mantahostels#8 (39 of 40 children closed), `cold-start`
  mantahostels#94 (20 of 20), the privacy-ops lawful-basis map mantahostels#1492 (10 of 11) and
  `indo-standing` mantahostels#551 (14 of 17). Read each map's shape before judging:
  ```bash
  gh api "repos/{owner}/{repo}/issues/<map>/sub_issues" --paginate \
    --jq '.[] | [.number, .state] | @tsv'
  ```
- **An issue describing something already happening**, as opposed to a surface
  that does not exist yet. Parking a present obligation on an uncalled card
  leaves nobody holding it. Worked instances: mantahostels#1613.
- **Anything a live session is working.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js list`
  and the issue's assignee both speak; a reaped session's assignee is a
  leftover, not a live claim.

## The loop

Order is not negotiable. **Where step 2 finds a genuine guardrail, the card is
annotated and committed BEFORE any issue closes**, so no guardrail ever exists
only inside a closed ticket. A re-file trigger has no card edit at all — its
close-time label is what makes it findable, so steps 3-5 run only when at
least one guardrail was added this run.

1. **Classify, and put the borderline set to the founder.** Group the qualifying
   issues by the card each belongs to. Anything you are unsure about is a
   question for him, priced — never a silent judgement.

2. **No card prose.** mantahostels#3291/mantahostels#3320 ruled a "Parked questions" block does not
   belong on a card at all — it dissolves by content class, and a re-file
   trigger behind a closed issue is indexed by a `card:<card-id>` label on
   that issue, never written onto the card. This step is folded into step 6:
   the label applied at close is what makes the issue re-findable when the
   card is taken (`gh issue list --state closed --label card:<id>`). Where a
   qualifying issue instead carries a genuine builder guardrail — a
   constraint on the build move itself, not a question — it goes into the
   card's `b` field directly, in that field's own voice, through the
   `roadmap-edit` skill's full 8-step loop; that is the only card edit this
   loop still makes.

3. **Bump the version and the digest together.** MINOR +1, the date and time
   read off the clock with `TZ=Asia/Makassar date '+%-d %B %Y, %H:%M'`, and the
   matching line in `docs/roadmap-digest.md`. `.husky/pre-commit` fails the
   commit if the two drift.

4. **Commit the roadmap.** By pathspec:
   ```bash
   git commit -m "…" -- docs/reference-roadmap.html docs/roadmap-digest.md
   ```

5. **Concision pass — before the closes, not after.** Call the Skill tool with
   "concision-pass" over the card prose you added, and commit any cut with the roadmap.
   Deferring it past step 6 would put a second roadmap commit *behind* the
   closes: for the window between them the card would not carry the text the
   closed issues point at.

6. **Close each issue.** A **normal** close — never `--reason "not planned"`,
   which reads as a rejection of work that was merely deferred. Apply
   `card:<card-id>` naming the card that will fire it (the one label family
   this repo keeps for a deferred issue, per mantahostels#235 and mantahostels#3291/mantahostels#3320).
   A guardrail already committed to `b` needs no label — it isn't a re-file
   trigger. The resolution comment names the card, states the question in
   plain words, and carries a line beginning `**Outstanding:**`, which
   `${CLAUDE_PLUGIN_ROOT}/scripts/guard-issue-close.sh` requires.

   Close the map last, after its children.

7. **Verify, then report.** Confirm every intended issue is `CLOSED` and count
   what the open frontier dropped to. Name what you deliberately left open and
   why. Reconcile against `docs/called-cards.md`: a card with a row there has
   been called, so its issues are not candidates for retirement at all.

## Closing a card's own issue

`${CLAUDE_PLUGIN_ROOT}/scripts/guard-issue-close.sh` refuses a hand close of a roadmap card's own
issue — that belongs to `/card-close` (mantahostels#165, mantahostels#220). Two things get past it
legitimately: a `wayfinder:map` label exempts (mantahostels#1490), and a parented issue is
not a card issue. Neither is a workaround; if the guard refuses, read its header
rather than reaching for another spelling.
