---
name: concision-pass
---

# concision-pass

A line in this repo stays only if it is **load-bearing** — the test is under
**Criteria**.

A `${CLAUDE_PLUGIN_ROOT}/.claude/skills/*/SKILL.md`, `CLAUDE.md` or `AGENTS.md` target is judged
against the `writing-for-agents` skill too — descriptions, information
hierarchy, no-ops.

**Yield depends on who wrote the text.** On text this session just wrote tenure
does not apply, and roughly half a dense new paragraph goes (mantahostels#501, the
review-gates approval-queue ruling); on pre-existing text roughly two in three
findings survive tenure (mantahostels#2677). **Never offer a pass as a token saving — except
on the always-loaded pool**, where token payback is exactly the ground, at
roughly **\$17 per 100 words per month, recurring** (mantahostels#1085). The pool is what
`${CLAUDE_PLUGIN_ROOT}/scripts/check-context-budget.js` counts under **POOL** — a hand run lists its
members, an undelivered description costing 0 B (mantahostels#1757) — and nothing else it
caps. **`docs/doc-map.md` is judged block by
block** (mantahostels#2548): **payback** for the prose read whole — §C, Capture and
placement, the propagation pass, the §B preamble, the authority-classes legend —
**readability**, as below, for §B's entry bodies and §A's rows, and **\$0.0129
per 100 words per read/month** for a block in neither list. The ban on
pre-trimming a draft to avoid a pass carries no carve-out — write the reasoning
out and let the pass relocate it to the resolution comment.

**Every caller runs this pass in the session that wrote the text**, the
`${CLAUDE_PLUGIN_ROOT}/scripts/concision-backstop.sh` backstop included (mantahostels#1143).

## 1. Pin what this change added

The fixed point is whatever the caller supplies — a commit SHA, a baseline file,
`HEAD`, a branch. With none given, use `HEAD` and audit the working tree.

Record the **net words added**, per file:

```bash
node ${CLAUDE_PLUGIN_ROOT}/.claude/skills/concision-pass/scripts/concision-scope.js <fixed-point> <the paths you wrote>
```

Name only the paths you wrote, and cut nothing you did not. The §6 marker still
takes the sha the hook names. A baseline *file* as fixed point is outside the
script: diff and count by hand.

Then read the additions: the diff the script prints under its total — or, where
it withheld the diff as over its cap, the `git diff` it names — or for the
roadmap, the per-card word counts of `b`/`log`/`mn`/`c.x` against the baseline.

**Where the caller asks for an audit of a *file* rather than of a change**, the
whole file is the text under judgement:
take no fixed point, record no net-words figure, and go straight to step 3. Its
findings are all pre-existing text, so step 4's tenure procedure runs on every
one (mantahostels#603). **A commissioned audit is
the draining session, so §4's no-cut gate does not bind it** (mantahostels#2677). Clear
tenure and cut.

Done when: every file the change touched has a net-words-added figure, or the
audit is a declared whole-file one and step 3 is next.

## 2. Check the floor

Under **150 net words added** — the floor step 1's output compares each file
against — skip step 3 for that file. Read its additions once against the criteria
yourself, cut what fails, and go to step 5.

Done when: either every added sentence has been judged against the criteria and
each failure cut or refused, or the change is at or over the floor and step 3 is
next.

## 3. Send it to a fresh reader

Spawn a `general-purpose` **Agent** per file (parallel, one message), each
pinned **`model: "sonnet"`** — never code review's reviewer (mantahostels#2614). **Give it
the text and the criteria and withhold the justification** — no explanation of
why any passage was written.

The agent has no other access to the criteria; paste **Criteria** below into the
prompt verbatim, then:

> Here is text added to `<path>` by one change: <the added text>. Also read the
> full file for context. Return a numbered cut list: for each, quote the exact
> sentence(s), say which criterion it fails, and state what a reader would do
> differently if it were gone (if nothing — cut it). Separately list any
> **pre-existing** text (not added by this change) that fails the same test.
> Propose no rewrites and edit nothing. Under 400 words.
>
> Artefact: .claude/tmp/concision-<slug>.md
>
> Write the cut list to that file — a flat slug, never a nested path — as you
> go, one finding at a time, and return it as well.

Hand the absolute path instead where the agent works in a throwaway worktree, a
relative one resolving inside that worktree rather than the checkout you are
watching.

Watch each file with one backgrounded `node ${CLAUDE_PLUGIN_ROOT}/scripts/watch-artefact.js <file>
120` — one of `docs/agents/guard-registry.md` §Subagent dispatch's mandatory sites. **Stall
fallback, on `STALLED` or `MISSING`: do that file's pass in the main session**,
reading its additions against the criteria yourself — never a re-dispatch.
When an agent's completion notification arrives, `TaskStop` its watcher first.

Done when: every file at or over the floor has a cut list back, from its agent
or from the main session.

## 4. Apply, and dispose of every finding

- **Text this change added** — apply the cuts.
- **Pre-existing text has tenure** — it survived an earlier pass, so cutting it
  takes evidence — **and is never cut in the pass that surfaced it** (mantahostels#2677).
  Two dispositions, and no third: **refuse** it where tenure plainly holds,
  quoting the evidence; otherwise **file** it, one issue per pass carrying all
  of that pass's filed findings. Cutting, compressing and
  relocating are the draining session's to do, on the ticket.

Clearing tenure is the draining session's job; run it here only to decide
whether a finding is worth filing at all. One call gathers every lookup and
renders no verdict:

```bash
node ${CLAUDE_PLUGIN_ROOT}/.claude/skills/concision-pass/scripts/tenure.js '<phrase>' <path>
```

1. **The introducing commit.** **Tenure holds only where that message speaks to
   this sentence's own content** — the issue, ruling or reason behind *this
   line*, not behind the commit at large. Then keep the line and quote the
   message as the refusal. A bulk authoring or whole-file rewrite always clears
   tenure: its body describes the rewrite, never any line inside it. Cleared
   means judge the line as new text (mantahostels#603). Where the `git log -L`
   rung reaches past `-S`'s oldest commit, read the oldest `-L` commit that
   wrote this sentence's substance (workflow-core#763).
1b. **A later ruling on the enclosing identifier.** `-S` finds only commits that
   changed *this* text, so a later pass ruling the line KEPT while cutting a
   *neighbour* is invisible to step 1 (mantahostels#3134); this scans the file's commit
   messages for the name of the function, class or constant the phrase sits in
   or beside. Read a hit exactly as step 1's. `none` here is not a clear.
2. **An earlier ruling on the tracker** — an earlier pass may have ruled on this
   passage already.
3. **The string asserted elsewhere.** A test asserting it makes the sentence
   load-bearing whatever it reads like. A §B `Restated in:` locator does **not**:
   it holds only the claim that entry's *The claim* line states, never every
   sentence sharing the bullet or section the locator names (mantahostels#722). Open the
   entry and judge the finding against its claim.

**`UNRESOLVED`, or exit 3, is not an absence** — it names the lookup that could
not run, and that one is yours to settle by hand before tenure counts as cleared.

Where `docs/doc-map.md` §A bars the edit the finding becomes an issue, not a
cut: `derived` and `generated-only` files are fixed at their generator.

**A finding that a reader acting on the text would be *wrong* is not a concision
finding, and this pass never cuts it.** **File** it with the rest of this
pass's findings; the session that rules it corrects the line in place, citing
that issue.

On a research artefact the pass runs on the untracked scratch file the
subagent wrote, **before** it is committed — `docs/agents/issue-tracker.md`
§Research artefacts. On that surface the pass is a **readability gate
whose cost is accepted**, never a token saving: exempting those files was refused
because the surface is too large to leave unread, and cost arithmetic does not
reopen it (mantahostels#1085).

Two things always survive a cut:

- **A fact the founder specified.**
- **Guard behaviour a session reads** — how to interpret a warning, a silence or
  an exemption (mantahostels#605). The fact is often on no issue at all, so confirm the
  issue carries it before cutting anything that reads like tool internals.

Where a fact belongs elsewhere, **relocate rather than delete**: a superseded
value goes to the `docs/doc-map.md` §B figure registry's `Supersedes` line,
everything else to the issue that settled it, with a pointer left behind.

**Tenure does not gate a relocation** — steps 1-3 clear a *deletion*. Confirm
the fact is on its issue, or put it there yourself, first. A relocation still
stops at step 3, on that step's reading: a test asserting the string, or a §B
entry whose claim *is* this sentence, holds it where it is.

**Grep the destination before calling a relocation blocked.** Already
carried → a plain cut leaving a `(§Bnn)` pointer. Genuinely absent and the file
held → ticket it and register the debt rather than waiting.

A refusal goes in the commit message beside the cuts it accompanied.

Done when: every finding against text this change added is applied, relocated,
or refused with quoted evidence — and every pre-existing finding is filed,
marked in place, or refused with quoted evidence, none of them cut here.

## 5. Verify mechanically, not by eye

```bash
node ${CLAUDE_PLUGIN_ROOT}/.claude/skills/concision-pass/scripts/check-facts.js <before-file> <after-file>
```

It lists every number, percentage, identifier (card id, `#issue`, `§ref`, clause
number) and quoted string present before and absent after. Account for every hit
out loud — but **it is wrong in both directions, so neither a hit nor a clean run
settles anything on its own.**

**A hit may be a false GONE**, so `grep -c` the bare string in the after-file
before recording it as a lost fact. Known modes: a code span written with escaped backticks inside a JS template
literal, or a token surviving only as a regex literal (`/§B/`) rather than in
prose; and a short span that survives nested inside a longer one.

**A clean run only covers the tokens it reads.** It reads a version stamp
(`v2.25`) and a bare git sha (`1349d2a5c`, 7-40 lowercase hex characters with at
least one `a`-`f` letter) as their own kinds (`mantahostels#3323`). It is blind to a figure
with a unit glued on — `12h`, `7d` — a version with no dot (`v7`) or an
uppercase `v`, a sha that happens to be all-digit, and any **rule carrying no
number, identifier or quoted string at all**. It can also false-GONE a
7+-letter word using only `a`-`f` (`defaced`) as a sha — the safe direction, so
`grep -c` clears it same as any other false GONE, above. So after a cut, grep the specific
durations, thresholds and windows yourself, most of all for a **superseded
value**, which reaches nowhere but git unless it lands on a §B `Supersedes`
line; and re-read the removed text for *constraints* as well as facts, grepping
the repo for each one's other home. Where a cut defers to another file, open
that file and confirm it states them — never write a deferral claim wider than
what the target carries.

Then re-run whatever the edited file's own gate is: `validate.js` for the
roadmap, `check-doc-map.js` for `docs/`, `npm run typecheck` for code. **A card
edit runs both of the first two, and neither reads the cut** — they backstop a
`doc-map-restatements.json` correction already made, never catch a cut that owed
one. `roadmap-edit` §What a card holds runs the pre-cut lookup that does.

Done when: every `check-facts.js` hit is accounted for and the file's own gate
passes.

## 6. Report and mark the pass

```bash
node ${CLAUDE_PLUGIN_ROOT}/.claude/skills/concision-pass/scripts/mark-pass.js <number of cuts>
```

It writes `.claude/tmp/markers/.concision-pass-<session-id>`: `base=`,
`findings=` and `route=in-session` (always, mantahostels#1143).

**`base=` is the session's own start point, not the step-1 fixed point** — the
script reads `.claude/tmp/markers/.concision-base-<session-id>`, written once at
`SessionStart`, because `pass_valid()` in `${CLAUDE_PLUGIN_ROOT}/scripts/concision-backstop.sh`
rejects a **descendant** of it, which any sha picked up mid-loop becomes the
moment anything commits. With no such file (a pass outside a hooked session),
add `--base <step-1 fixed point>`. `findings=` is the number of cuts, digits
only. Describe the cuts in your reply, never in the marker.

**So the pass covers every prose file this session wrote since that base**, not
only the file the caller named.

**A pass over the always-loaded pool also replaces the one object on
`docs/always-loaded-passes.json`'s `passes` array** — the durable record
`${CLAUDE_PLUGIN_ROOT}/scripts/check-always-loaded-pass.js` (`npm run status`) reads the monthly
cadence from, the marker above being swept — in the commit carrying the cuts:

```json
{ "date": "2026-09-02", "sha": "<40-hex commit>", "issue": "mantahostels#2500" }
```

A pass that cut nothing leaves it as it is; a wrong entry is corrected in place.

Report: net words before → after, the cut categories used, anything refused and
why, and how each pre-existing finding was disposed.

Done when: the marker file records the session base, the cut count, the
route and a hash of each file judged, and the report carries all four of the items just listed, saying "none" where a
category is empty rather than omitting it.

## Figures behind this loop

**150 net words per file** (§2) gates only the fresh reader. **50 net words,
session-wide** is what `${CLAUDE_PLUGIN_ROOT}/scripts/concision-backstop.sh` (`THRESHOLD`) uses to
demand a pass at all — so a change can be audited by the backstop and never
reach a subagent. The backstop's figure spans the whole shared working tree, so
it counts a neighbour's uncommitted files; step 1's counts only the paths you
name. ⚠ The 150-per-file floor was never measured.

## Criteria

The test on every sentence: **is it load-bearing** — does a reader do something
different because this line is here? No → delete the whole sentence, words and
all.

For agent-facing text (a skill, `CLAUDE.md`, `AGENTS.md`, a doc an agent
reaches by pointer) the test is model-relative: does it change behaviour versus
the model's default? `writing-for-agents` §Pruning holds it, under no-ops.
Founder-facing prose keeps the reader test above.

Reliably fails:

- **Restatement** — the same rationale made a second or third way.
- **Meta-commentary** — text about the text: why a rule is being recorded, that
  something is "recorded as a rejection, not left as an absence", which file
  carries what.
- **Self-justification** — a sentence explaining why the sentence before it
  earns its place ("this is the whole point of choosing shrinkage").
- **History of how it got here** — superseded framings, what an earlier version
  said, a note of what changed or was removed, a deprecation or legacy comment,
  and a "don't do X" line about a removed thing.
- **Verification theatre** — "confirmed by X, *not by inference*". Cite the
  source; drop the protesting.
- **Sample output** whose trigger conditions are already stated.
- **A warning against a ghost** — cautioning against a figure, rule or reading
  that appears nowhere the reader can reach it. Check it exists before keeping
  the warning; if it doesn't, the finding belongs on the issue.
- **Rhetorical closers** — the flourish at the end of a paragraph that names a
  consequence already stated.
- **Evidence for the rule it sits beside** — the measurement, incident or census
  that justified a rule, quoted next to it. The rule binds without it. Relocate
  it to **the issue that settled the rule** and cut it here, leaving the
  citation; never delete it outright. Check the issue carries it first, and post
  it there yourself where the doc holds the sole copy. Not `docs/doc-map.md` §B,
  which holds the live value, what a reader does with it, the conditions that
  invalidate it and the citation — and nothing else (mantahostels#545).
- **Reference at the wrong tier** — load-bearing material a reader needs only
  on demand, inlined where a pointer would serve: a list a script parses out of
  prose, a census consulted once a quarter. Relocate it down — a co-located
  file, or the data file its checker reads — and leave the pointer. Never
  delete it, and where the move changes what a script parses, it becomes an
  issue, not a cut.
- **Provenance trailers** — an authorship or application date, a commit sha, a
  PR or branch name, a rebase or anchor chronicle. The issue number is the
  provenance and git holds the rest. A date on a ⚠ marker is exempt: they are
  parsed and aged by `${CLAUDE_PLUGIN_ROOT}/scripts/check-doc-map-markers.js`.
- **A cache of what the environment already answers** — a line restating
  `package.json` scripts, a config file, a directory listing or `--help` output.
  The agent can look those up; the line earns its load only where the lookup is
  expensive.

Passes, and stays:

- A rule or invariant, and a figure the reader **acts on** — a threshold to
  compare against, a value to write down, an argument to pass. A number is
  load-bearing by what the reader does with it, never by being a number: one
  that only justifies the sentence beside it is evidence, and moves.
- **A constant hedged as a guess** — *"A first guess, and stated as one"*, or any
  wording saying a chosen value is unmeasured. `${CLAUDE_PLUGIN_ROOT}/docs/code-standards-base.md`
  §G2 makes it a **hard** standard: never a restatement finding, and never a
  provenance one against the ticket cited beside it (workflow-core#250).
- Context that makes a neighbouring sentence parseable — **concision never
  overrides self-containment**. If a passage runs
  long, the fix is fewer points made properly, never the same points in
  shorthand.
- A gloss on an identifier on first use (`#65 (the ledger-application ticket)`).

`CLAUDE.md` loads every session, so it holds rules that change mid-session
behaviour and nothing else; what supports a rule lives in the doc the rule
points at. Figures are held to this as hard as prose.
