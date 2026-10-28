---
name: roadmap-edit
---

# roadmap-edit

`reference-roadmap.html` is the adopter's canonical action guide: a
single HTML file whose content lives in one JavaScript array, `const ITEMS =
[...]`, plus `const AREAS` and `const PHASES`. The rest of the file is render
code. Editing it wrong causes silent damage — a broken `needs` link, a card
inserted out of execution order, a missed version bump, a `done` card with no
`log` — that the page won't visibly complain about.

## What a card holds

**A card is an action guide for whoever will do the task, and holds three
things**: the action, the guardrails against wrong moves that builder is likely
to make without them, and the done-when. Not the card's history, not the
argument for its own existence, not a cross-card essay. Context earns a line
only where it changes what the builder does or stops a likely wrong move — the
reasoning that got the card here goes to its issue, and a load-bearing
Manta-world fact another document depends on to `docs/doc-map.md` §B (mantahostels#2979) —
a figure, a licence condition, a threshold, or a condition reopening a settled
decision (mantahostels#3219).

**Where the card is the surface a fact settles on, say the verdict on the
card's issue** — `§B: yes` or `§B: no, because …` — before the commit that
writes the card. One line, and often the answer is no (mantahostels#3219).

**This section governs admissibility for the whole card record** — what may sit
on a card at all. [`FIELDS.md`](FIELDS.md) governs **placement**:
which field each admissible thing lands in. The three limbs above are `b`'s and
are unamended; `mn` (an execution note) and `log` (a past-tense outcome) were
never asked to satisfy them. **`c.x` is not a home for the argument for
the card's existence** — mantahostels#2979's bar is a card-level bar, so that content goes
to the card's issue, not to another field (mantahostels#3187).

**Two more field pointers, neither amending the three limbs above** (mantahostels#3193).
The done-when limb has its own field, `dw`: draft it there directly, never into
the body. And a fourth thing may sit on a card — `why`, one or two sentences of direction-under-consideration
plus what the card unlocks — in its own capped field, optional on an existing
card and **required whenever a session takes that card**.

**When a session takes a card, run `gh issue list --state closed --label card:<id>` for that card's id first** — it recovers the re-file triggers parked against this card by an earlier close-to-card, per mantahostels#3291 and mantahostels#3320: a closed issue's trigger lives on the label, never as prose on the card itself.

**The cards live today were not written to this rule and have not been swept**
(mantahostels#2979), so read a neighbouring card for ordering and voice, never as an
exemplar of shape.

Apply the rule while drafting. `concision-pass`, which step 6 runs afterwards,
is a cutting pass and never asks whether a body has the right parts. A card
body carries no rejected option: where a builder would otherwise make a move
an issue refused, state it as a current rule citing that issue.

Step 6's validator warns where an edit touches a body over **250 words** — a
length proxy for a shape rule no script can read. A trim that stays over warns
too (mantahostels#3335). A long card is not automatically wrong and a short one not
automatically right: the answer to the warning may be that the length is
earned, recorded as a `capOk` entry. **What it cannot see**: an over-ceiling
body no edit touches stays silent; `scripts/report-roadmap-ceilings.js`, the
scheduled census, is what lists it.

<!-- guard-registry:begin -->

- **Three more ceilings join the 250-word body one, on the same touch gate and
  the same WARN severity**: `mn` 30 words, `c.x` 80, `log` 80 (mantahostels#3187, mantahostels#3335).
  **Unenforced** (mantahostels#3188): step 6's validator warns rather than refuses, through `scripts/check-roadmap-valid.js`
  in the pre-commit gate, and all four share the blind spot above.
- **`why` over 40 words is a validator ERROR the moment it's present at all**
  (mantahostels#3193). **Enforced**: `scripts/check-roadmap-valid.js` refuses the commit.
- **`dw` is required on every non-done card — a validator ERROR on absence**
  (mantahostels#3190). **Enforced**: `scripts/check-roadmap-valid.js` refuses the commit.
- **A fifth ceiling (60 words) joins `dw` to the touch-gated WARN list above**
  (mantahostels#3190). **Unenforced** (mantahostels#3188): step 6's validator warns rather than
  refuses, and shares the same blind spot.
- **Before cutting a sentence carrying a figure, threshold, licence condition
  or date from a card body, run `npm run report:card-restatements -- <card-id>`
  and read every entry it names** (mantahostels#3339). Where the sentence is the copy an
  entry's *The claim* line describes, the cut is a **propagation pass**, not a
  trim: correct `docs/doc-map-restatements.json` and the entry's `Restated in:`
  count together, or leave the sentence. **Unenforced** (mantahostels#3191):
  every roadmap locator is a bare card id (mantahostels#1573),
  so `check-doc-map.js`'s DEAD-ANCHOR check reads quoted locators only and skips
  every card path (`scripts/check-doc-map.js:1246-1249`), and the count FAIL fires
  on the sidecar edit this step exists to make.
- **A card line citing mantahostels#3196, mantahostels#3197 or an ADR-0006
  (`docs/adr/0006-disposal-writes-back-to-source.md`) write-back is a disposal
  record, not card history: compress it if you must, never lose the pointer**
  (mantahostels#3339). **Unenforced**: nothing reads a card body for the citation.
- **A `capOk` exemption is void on touch**: a session editing a field a
  `capOk` entry names re-judges it on the spot — cut it under the ceiling and
  drop the key, or re-record it citing its own ruling issue (mantahostels#3189). The
  entry silences `CARD SHAPE` on a touch that does not grow the field, never
  on growth (mantahostels#3335). **Unenforceable**: no check can tell a re-judgement from
  a silenced touch.
- **An over-ceiling `dw` is always cut, never exempted**: `capOk` cannot name
  it, so a `dw` over 60 words warns on every touch until its surplus is
  relocated into `b` — which can be exempted — or dropped: a done-when is the completion condition, not a second body
  (mantahostels#3498).
  **Unenforced** (mantahostels#3188): step 6's validator warns rather than refuses on
  both the touch and a `dw` key under `capOk` (`MALFORMED EXEMPTION`),
  through `scripts/check-roadmap-valid.js` in the pre-commit gate.
- **`STALE EXEMPTION` and `MALFORMED EXEMPTION` read the `capOk` record
  itself** (mantahostels#3189). **Unenforced** (mantahostels#3188): step 6's validator warns at WARN
  severity through the same route.

<!-- guard-registry:end -->

## The non-negotiable loop

Follow this order every time. Steps 2 and 6 are the ones that catch mistakes;
never skip them.

1. **Snapshot the committed original first.** You edit `docs/reference-roadmap.html`
   in place; git holds the untouched copy you diff against. The snapshot is
   **HEAD-derived and lives inside the repo**, at the gitignored, **session-scoped**
   path `.claude/tmp/markers/.roadmap-baseline-$CLAUDE_CODE_SESSION_ID.html` — the same shape
   `/card-close` uses for its own baseline (see `.claude/skills/card-close/SKILL.md`
   step 5).
   ```bash
   git status --porcelain docs/reference-roadmap.html   # empty, or poll below
   mkdir -p .claude/tmp/markers && git show HEAD:docs/reference-roadmap.html \
     > ".claude/tmp/markers/.roadmap-baseline-$CLAUDE_CODE_SESSION_ID.html" || exit 1
   ```
   **Session-scoped because sessions run in parallel in one working tree.** A
   fixed filename is shared state: a second loop overwrites it, then deletes it
   on finishing, and step 6 fails with `No such file or directory` through no
   fault of yours. `CLAUDE_CODE_SESSION_ID` is in the environment of every
   `Bash` call, so use it inline — never assign it to a shell variable, which
   would not survive to the next call.
   **If `git status` is not empty, poll and retry — do not stop.** Uncommitted
   roadmap changes mean the scope diff would baseline against the wrong file,
   and a parallel roadmap edit usually clears within a minute (mantahostels#1074). Run
   this **as a background Bash job** — a foreground `sleep` is blocked, and 5 minutes
   outruns the default tool timeout. Its completion wakes the session; end the
   turn meanwhile (`docs/agents/guard-registry.md` §Conventions).
   ```bash
   for _ in $(seq 10); do
     if [ -z "$(git status --porcelain docs/reference-roadmap.html)" ]; then
       node scripts/session-arbiter.js claim docs/reference-roadmap.html && exit 0
     fi
     sleep 30
   done
   exit 1
   ```
   It takes the claim in the same run it sees the file clean, so a neighbour
   cannot take it in the gap between the read and your first edit. **Exit 0 →
   proceed to the `git show` above. Non-zero (all 10 attempts exhausted) →
   abandon the edit and register the debt**, naming the card, so the collision
   is countable rather than vanishing:
   ```bash
   node scripts/session-arbiter.js debt own docs/reference-roadmap.html <issue> "<card-id>: <the edit>"
   ```
   Then report the abandoned edit and carry on with the rest of the ticket.
   `git show` failing is a hard stop, not a retry: no baseline means step 6's
   scope diff is unverifiable.

   **In the repo, not `/tmp`** — `/tmp` does not survive a WSL2 restart. The
   directory is in `.gitignore`, so it never enters a commit; leave it in place
   until the loop finishes, then delete it by its session-scoped name — a bare
   `.roadmap-baseline*` glob would take a parallel session's live baseline with
   it.

2. **Establish the blast radius before the first `str_replace`.**
   Grep for every card the change touches — the target card, every card whose
   `needs` names its id, and every `b`/`mn`/callout mentioning that id — and
   list them before editing anything.

   **Then view exact line ranges before every `str_replace`.** Do not edit from
   memory or from an approximate match. The cards contain nested single and
   double quotes, `&amp;`/`&nbsp;` entities, and inline `<b>`/`<i>`/`<code>`
   HTML that make near-miss matches fail or, worse, match the wrong card.
   `grep -n 'id:"<card-id>"'` to find the line, then `view` that range, then
   copy the real bytes into `old_str`.

3. **Make the edit at the right place in execution order.** Cards within a
   phase are ordered as the sequence you'd actually work through,
   dependency-first — NOT by insertion date, state, or id. When adding a card,
   insert it at the point in its phase where it would actually be done, after
   every same-phase id in its `needs`. Read neighbouring cards' `b`/`c` text
   first: some ordering dependencies are narrative, not captured in `needs`.
   Draft the body to §What a card holds.
   Done when the card sits after every same-phase id in its `needs`.

   **Where this edit discharges an item a source declares open in its own
   words** — a gap ledger, a `Disposition: worth a ticket` row, a "no card
   covers this" or "parked — revisit as a card" note — write the closure
   back to that source in the same commit, per
   `docs/adr/0006-disposal-writes-back-to-source.md` §2: an editable source
   has its declaring line edited in place or deleted; a `derived` or
   `generated-only` one is written back at its generator's input, never by
   hand; a declaration that is an aged sidecar marker
   (`docs/doc-map-classes.json` `role`) is cleared there; a file that merely
   mentions the area takes nothing. Grep for the
   declaration; none found, nothing owed. Carry any edit into step 8's
   pathspec.

4. **Apply the model/effort (`m`) and note (`mn`) fields correctly**, per
   [`FIELDS.md`](FIELDS.md).

5. **Bump the version in the same edit.** The `<p class="docmeta">vMAJOR.MINOR
   · updated D Month YYYY, HH:MM</p>` line is the ONLY version marker — never
   duplicate it in a filename. MINOR +1 for any content change (a card added,
   edited, removed; a log added). MAJOR +1 and MINOR reset to 0 for a
   structural change (an ITEMS schema/field change, phase restructuring, or a
   change to render logic). **Date and time both update on every save**, en-GB
   date + 24-hour time (e.g. `4 July 2026, 16:15`), in the **founder's local
   time zone — Lombok, WITA, UTC+8, no DST.**

   **Never reckon this time — read it off the clock, when you make the edit:**
   ```bash
   TZ=Asia/Makassar date '+%-d %B %Y, %H:%M'   # paste verbatim
   ```
   `TZ=` is right whatever the host is set to, so don't convert, and don't
   reuse a time from earlier in the session — re-run it. Step 6 checks the
   stamp against the clock.

   Never bump without a content change; never change content without bumping.

6. **Validate, then diff for scope.** First assert the baseline is still there
   and still *is* HEAD — an interrupted loop is exactly the case where it isn't:
   ```bash
   B=".claude/tmp/markers/.roadmap-baseline-$CLAUDE_CODE_SESSION_ID.html"
   test -s "$B" || { echo "BASELINE MISSING — redo step 1"; exit 1; }
   git show HEAD:docs/reference-roadmap.html | diff -q - "$B" \
     || { echo "BASELINE IS NOT HEAD — redo step 1"; exit 1; }
   ```
   On either `exit 1` above, retake the baseline from HEAD per step 1 — safe
   at this point, because HEAD is still the pre-edit roadmap until step 8
   commits — then re-run this step.

   Then run the bundled script against the working copy, passing the baseline:
   ```bash
   node .claude/skills/roadmap-edit/scripts/validate.js docs/reference-roadmap.html \
     --original ".claude/tmp/markers/.roadmap-baseline-$CLAUDE_CODE_SESSION_ID.html"
   ```
   **Always pass `--original`** — it has no default by design, and it is the only
   check that the edit hit the card it was aimed at. On a failure, fix the edit
   and keep the flag. An unreadable path is a fatal ERROR, so a lost baseline cannot
   pass as a clean run.

   It extracts `ITEMS`/`AREAS` without executing the page's DOM code, checks the
   [`FIELDS.md`](FIELDS.md) rules it can enforce plus the docmeta stamp, and —
   via `--original` — reports exactly which card ids were added or removed and
   whether the version moved. Read its output rather than assuming the set.

   **If you see a `SCHEMA DRIFT` or `VERSION TRIPWIRE` warning, don't dismiss
   it as noise.** It means either a card field appeared that this script
   doesn't know about, or the roadmap's MAJOR version moved since this script
   was last reviewed — both mean the schema may have changed in a way the
   checks above don't cover yet. Stop, read the new/changed structure, decide
   whether a rule needs updating (here and/or in [`FIELDS.md`](FIELDS.md)),
   then update `KNOWN_ITEM_FIELDS`/`KNOWN_CALLOUT_FIELDS` at the top of
   `validate.js`. Close the VERSION TRIPWIRE half of the loop in this repo's
   own `.claude/workflow-core.json` — its `roadmapMajorPin`, where the repo is
   an adopter of the core (`resolveExpectedMajor()`, #54) — or in
   `EXPECTED_MAJOR` at the top of `validate.js` for the core itself. A drift
   warning with no schema change needed is a false alarm and fine to clear by
   updating the pins.
   **Fix every ERROR before shipping.** Confirm the
   added/removed list matches only what you intended — an unexpected id in that
   list means a `str_replace` hit the wrong card.

   **Then cut the bloat, before the digest is generated.** Call the
   Skill tool with "concision-pass", the session baseline as its fixed point. Its own
   step 6 marker records the session's start sha, not this baseline.

7. **Generate the digest.** After validation passes, regenerate the slim map
   Claude Code imports (`docs/roadmap-digest.md`) — from the same file you just
   validated, so both files carry the same version stamp.
   ```bash
   node .claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js docs/reference-roadmap.html \
     --out docs/roadmap-digest.md
   ```
   The generator strips card bodies/done-when/callouts and emits one line per
   card (id, state, title, needs, effort, `mn`), grouped by phase. It should
   report all cards and the current version; a chars figure well under 40k is
   expected (Claude Code's memory threshold). If it errors or the version doesn't match the HTML you just edited,
   stop — do not ship a half-updated pair.

8. **Commit both files in one commit.** Add any source document step 3's
   write-back edited to this pathspec.
   ```bash
   git commit -m "<what changed> (vX.YY)" \
     -- docs/reference-roadmap.html docs/roadmap-digest.md
   ```
   **Never `git add` first** — commit by the pathspec above (`CLAUDE.md`
   §Conventions, on mantahostels#63, where one session's staged files landed inside
   another's commit). **The two files ship together, always** — never commit
   the HTML without its regenerated digest. Report to the founder in two lines:
   version, cards added/edited, and the validator's pass line. No long postamble.

   **The commit gives back both claims**, printing `Released …` (#2058). Where
   it names only one, the other is still dirty: commit it, or release it by
   hand once clean — `node scripts/session-arbiter.js release <path>`.

   **The commit is gated, and the gate is not this skill's validator.**
   `.husky/pre-commit` runs `scripts/check-roadmap-valid.js` on any commit
   staging `docs/reference-roadmap.html` (mantahostels#698). A validator **ERROR** refuses
   the commit; **WARNINGs** — `SCHEMA DRIFT`, `VERSION TRIPWIRE`, `CARD SHAPE`,
   an unbumped
   version, and `PHASE-BOUNDARY` — and the list of cards added or removed print
   and pass. **`PHASE-BOUNDARY` is the one that asks for work after the commit**
   (mantahostels#1130): flipping a `validate-pN` card to `done` re-opens the agent-spend
   ladder, and the warning names what to read. Relay it. A host that does not
   declare `"capacityLadder": true` gets a skip line instead (#748). It reads the
   **staged blob** against `HEAD`'s, never the working tree, so a neighbour's
   half-saved roadmap cannot fail your commit.
   The scheduled `Document guards` job re-runs the same checker in `--tree`
   mode (mantahostels#974), judging the roadmap as it stands. That is what catches a break
   arriving by a route no commit gate sees — a `--no-verify` commit typed in the
   founder's own terminal, and `git cherry-pick`, `git revert`, `git rebase` or
   `git am`, none of which runs a commit gate at all (measured at mantahostels#1679). An
   auto-resolving merge is **not** such a route (mantahostels#1679):
   `.husky/pre-merge-commit` runs the whole pre-commit stack over the merge's
   own delta.

## The `ITEMS` schema

Every field rule, plus the extraction snippet for scripting against `ITEMS`
directly, lives in [`FIELDS.md`](FIELDS.md). **Read it before adding a card or
editing any field**, and whenever step 6 reports `SCHEMA DRIFT`.

