<!-- CORE-OWNED. Rendered from workflow-core's docs/doc-map.md by scripts/generate-core-docs.js, and REWRITTEN in an adopter on every bump. Never imported at session start. Do not edit. -->

# Workflow core — the document-map method

The method every repo's `docs/doc-map.md` is run by: its authority classes, the rules for §A's register and §B's figure entries, the propagation pass, and where a settled fact goes. The register, the entries, the routes and the shed ledger are each repo's own, in its `docs/doc-map.md`. A `scripts/` path here is relative to the workflow-core root: the installed plugin in an adopter.

## Authority classes

| Class | Meaning | Update route |
|---|---|---|
| `source-of-truth` | Owns facts nothing else may contradict | Direct, or via the named skill |
| `derived` | Regenerated from a source; hand-editing breaks CI | Regenerate only |
| `generated-only` | Re-synthesised wholesale by a skill | That skill only |
| `free-edit` | Working material with no authority | Direct |
| `binary-asset` | A non-text file | Replace wholesale |

## Section A — document register

**The tables below are generated. Never edit a row by hand** — register the document, which writes one key to `docs/doc-map-classes.json` and lets the row render:

```
node scripts/register-doc.js <path> --class <token> --section <name> [--reader <token>] [--qualifier <text>] [--role <text>] [--route <text>] [--new-section]
npm run gen:doc-map-section-a
```

`--class` takes one of the five tokens in §Authority classes. `--section` must spell a heading below exactly, and `--new-section` mints a new one. `role`, `route` and `consumes` override a generated default, and are written only where the row must carry what the default cannot. **`route` is the one whose default can be wrong**: a vendored skill defaults to `Direct` and must never be hand-edited. `reader` (`agent`, `human` or `both`) is required on every `.md` and `.html` key and refused on any other (assertion 31). The prose around the tables, this included, is hand-written, and the generator keeps it byte for byte.

**Registering a document owes an orphan check** (mantahostels#3198), unless its subsection is in `register-doc.js`'s `ORPHAN_CHECK_EXEMPT` — an exemption list, so a subsection minted later owes the check by default. Read the file for a commitment — work, a decision or a constraint carrying a completion condition — that names no card and no issue. Dispose of a hit in the same session: where the `roadmap` module is on, a card through `roadmap-edit` or a trigger line on the card that fires it; where it is off, an issue; or the document's own gap line gaining its owner. A ruling given no card or issue goes to the founder priced first. **Named residual:** a key written by direct edit, a bulk write and a re-sectioning meet no reminder.

**A `consumes` gloss scopes to the reference it hangs on.** Where it also covers the reference immediately before it, open it `with <other-ref>: `, spelling that reference as §A prints it — `check-doc-map.js` FAILs a prefix naming anything else (mantahostels#2647) — or word it to name more than one thing on its face: a plural, or two nouns coordinated.

## Section B — load-bearing figure registry

Every entry: **Owner** (the one document allowed to change it) · **Inputs** (what it is derived from — change one and the figure is re-derived) · **Restated in** (every file carrying it) · **Supersedes** (the value it replaced, so a stale copy is recognisable on sight) · **Settled at** (the ticket that decided it). `Settled at` is never merely absent: `**Settled at #<n>**`, or `**Settled at:** none — <why>` where nothing decided it (assertion 10).

**An entry is a map, not a record.** It carries the live value, what a reader does with it, and what invalidates it. Derivation, measurement narrative, build history and prose another file owns go to the settling ticket. Enacted statutory text quoted as the operative test a claim turns on *is* the claim, and stays (mantahostels#1935).

- **What earns an entry: a load-bearing fact about the project's world** — product, business, catalogue, the law binding it. **A ruling about the repo's own machinery earns none**: it goes to its owner document, or to the settling ticket where that owner is always-loaded. **Ties default to no** (mantahostels#1728): unable to tell which subject a fact is, write no entry and record it on the issue you are working.
- **The write is not unilateral** (mantahostels#1728). Record the fact on the issue you are working and report that you did; it enters §B when the founder confirms it belongs.
- **The confirmation is written down before the entry is** (mantahostels#2884, mantahostels#3225). Post it on the settling issue first — his words verbatim, or the bare option letter where he answered a lettered round, never a paraphrase of what he meant. The commit adding a `### B<n>` id absent from HEAD adds a row to `docs/doc-map-admissions.json` — settling issue, his answer, that comment's permalink — or assertion 29 FAILs it. The checker reads the row's shape offline and never fetches the URL. A cap split is not an admission: its row carries `capSplit` and the id it came from.
- **The writer verifies; the handover does not.** An entry is written only by a session that has re-derived the value against the files and searched **closed** tracker issues for prior rulings on it. Re-read every entry a drafted entry cites at pasting time, not drafting time (mantahostels#767). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#805) -->

**An entry carries at most 300 words of prose** (mantahostels#891) — the entry minus its skeleton bullets (`Owner`, `Inputs`, `Restated in`, `Supersedes`, `Settled at`). Over cap, cut or split; split only where the figures differ in provenance. A new entry over cap is refused at the commit that adds it (assertion 14).

**The cap binds on touch:** a session editing an over-cap entry brings it under 300 in that same edit, and the currency of a cut is surplus wording, never a claim (mantahostels#1935). An entry that cannot reach 300 without dropping a claim stays over cap and says so in a top-level bullet of exactly this shape — the ticket that ruled it over cap in the parentheses, no date and no count:

```
- **Over cap by ruling (#<n>):** every claim here is load-bearing — never cut one to reach 300; read the count from `overCapEntries()`.
```

**A marked entry may not grow** (mantahostels#2050): pay for an addition by cutting surplus wording in the same entry, and where it holds none the addition stands. `check-doc-map.js` FAILs a marker on an entry now at or under the cap (assertion 21), and WARNs on a marked entry that grew (22), a line reaching for the marker's shape and missing it (23), and a marker dropped while its entry is still over cap (24). **An entry carrying no marker is one nobody has touched** — its silence asserts nothing about whether its claims are cuttable.

**An id is never reused or renumbered.** Take one from `node scripts/session-arbiter.js alloc-entry docs/doc-map.md`, which allocates it and claims the append slot in one step (mantahostels#970); a duplicate is uncorrectable once written (assertion 6). A commit removing an entry raises `highWaterMark` in `docs/doc-map-high-water.json` to its id where the mark is lower, and a new id sits above the mark (assertions 12 and 13); the issue removing it says where its substance went.

**A claim on this file is one region** — one `### B<n>` entry, §Capture and placement §5's shed ledger, or one top-level section. `node scripts/session-arbiter.js release docs/doc-map.md` drops every region you hold.

**Anchor a scripted edit inside its entry.** §B's bullets repeat verbatim across entries, so a replacement anchored on one can edit the wrong entry and commit green (mantahostels#641). Find the `### B<n>` heading, search only below it, assert one hit, then `grep -n` the new string and confirm the nearest `### B` above it is the entry you meant. No checker catches a miss.

**The machine-parsed lists live in data files keyed by `B<n>`, not in the entry** (mantahostels#590): restatement paths in `docs/doc-map-restatements.json`, retired phrases and their legitimate-hits allowlist in `docs/doc-map-retired-vocabulary.json`, superseded values and their allowlist in `docs/doc-map-superseded.json`. The entry keeps a pointer bullet in one of three forms; assertion 11 FAILs any other shape, and a count disagreeing with its key:

```
- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.
- **Restated in:** none — <one clause saying why>.
- **Supersedes:** see `docs/doc-map-superseded.json`.
```

Either `Restated in` form may end with the warning sign, then `**Restated-in is known incomplete**.` A date, where the marker names specific outstanding work, goes in the sidecar's `knownIncomplete`, never in the bullet.

- **A locator pins a sentence by its `§` section, a verbatim `"quoted phrase"`, or both — never a line number**, which drifts on every edit above it (mantahostels#3151). Assertion 27 FAILs an `L<n>` token or a `<file>:<n>` citation in a `locator`, `gloss`, `note` or entry prose; assertion 28 FAILs a quoted phrase the file no longer holds byte for byte. A restatement inside a roadmap card is the path `docs/reference-roadmap.html` with the bare card id as its `locator`, one path object per card. Which part of a file holds the copy is that path's `gloss`; prose about the entry as a whole is the entry-level `note`.
- **A restatement in §A is a path on `docs/doc-map-classes.json`**, one path object per key, its `locator` naming the field (`role`, `route`, `consumes`, `classQualifier`) and the key (mantahostels#2461). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#805) -->
- **A claim entry carries no number, so it carries a retired vocabulary** — the phrases a stale copy will use, the claim's own words appearing nowhere in its dependents — with the hits that are legitimate and a `Replacement:` line stating the surviving wording or naming its owner (mantahostels#204). Each phrase is stored as its `stem` beside the `literal` it retires; stems widen the match. In JSON, `\b` is a backspace: a word boundary is written `\\b`.
- **A claim entry is created when the claim is settled, not when it is applied**, marked known-incomplete for the propagating session to complete (mantahostels#26).
- **A superseded entry's needle is the whole phrase a value is named by, never the bare number** (mantahostels#2444), and a value no distinctive literal carries is listed `scanned: false`. A permanently-correct hit goes on the entry's allowlist, anchored by content and scoped to its needle: `{ "anchor": "…", "needle": "~22%" }`.
- **Writing about the warning sign raises one**: `scripts/check-doc-map-markers.js` reads the sign followed by a space and a word as a marker wherever it appears, so write it hyphenated or say "the sign". A date the marker states rather than confirms is tagged `(standing)`, and nothing ages it (mantahostels#1357).

## The propagation pass

Run this whenever a settled, load-bearing fact has to reach the corpus (mantahostels#25). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#805) -->

**Not a skill, and not an aid.** Proposing a `doc-sync` skill (mantahostels#168) or a tool that identifies the affected documents for you (mantahostels#169 — no aid that reads §B can fix §B being wrong) reopens two settled rulings.

### 0. The door test — is the fact pinned? (mantahostels#168)

A session **never discovers mid-flight that it has to settle something**.

- **Pinned** — value final, basis checked against the files, every prior ruling found → run the pass, whatever its reach.
- **Not pinned** → hand back to `/wayfinder`.
- **Pinned but too large for one context** → `/to-tickets`, batched by blast radius. Never `/wayfinder`: there is nothing to decide.

**Which route applies is a judgement, and no count decides it** (mantahostels#218).

A session that finds its input wrong mid-pass stops and hands back. The **one exception is mechanical recomputation** — inputs unchanged and agreed, one answer, no choice. The moment a choice appears (which of two bases is right, whether a superseded figure should have moved at all, what a claim now means), it hands back. Post the recomputation on the settling ticket, which the entry cites.

### Scope (mantahostels#27)

Section A's register **plus the generator behind every `derived` entry**.

**Out:** vendored skill bodies under `.agents/skills/` — local edits are lost on re-vendor.

### 1. Walk §B to fixpoint

Identify the entries the fact touches — including entries whose **inputs** it changes, not only those quoting it. For each, walk **owner → inputs → restated-in**, in that order: update the owner first, because a consumer edited before its owner is a fork.

**The owner leg is a full read of the owner document, every pass** — not the section the entry's citation points at, and not only the paths `Restated in` names (mantahostels#2736). A stale copy found inside the owner is corrected in the same pass, by step 3's route for its class.

**Re-derive dependent figures rather than substituting strings** — a figure computed from another carries no textual link to it. Record the supersession in the entry, so the old value stays recognisable on sight.

Then re-run over the entries that round changed, until a round adds none.

### 2. Search, keyed to the figures the previous round newly implicated

Registry walk and search have complementary blind spots, so run both (mantahostels#87, mantahostels#171).

- **Literal leg.** Grep the figure and every value it supersedes. **For an entry with no number, grep its retired vocabulary, not the claim.** Check each hit against that entry's legitimate-hits list before touching it. Grep the **stem**, not the phrase: a writer paraphrases.
- **Residue leg.** Read for the claim as *stated*, not as worded.
- **Cost ceiling:** a round searches only the figures the previous round newly pulled in. A figure already searched is not searched again.

### 3. Dismiss §A group-wise, by subsection and class

Every group gets an explicit touch/no-touch verdict **with a stated reason** — "all vendored-skill symlinks, no business content, no-touch" is one line. "Does this file mention X" is step 2's question, not this one's.

| Class | Pass behaviour |
|---|---|
| `derived` | Edit the generator named in §A's update route, then regenerate. Never hand-edit the artefact |
| `generated-only` | Never a hand edit — through the skill §A's route names, and for the operating manual, below |
| `free-edit` / `source-of-truth` | Direct edit; bump the version where §A's route says so |
| `source-of-truth` via `roadmap-edit` (the roadmap HTML, where the `roadmap` module is on) | Invoke the skill in-session |
| `binary-asset` | Carries no claims — never a target |

**The operating manual, where the repo has one, is never ignored and never hand-edited.** Check `manual-sync`'s targeted-correction rules (`.claude/skills/manual-sync/SKILL.md`): a cited source, no edit to §8 (Current), and no narrowed confidence band. All pass → run targeted-correction mode in-session; the §B entry is the cited source. Any fails → file a GitHub issue citing the entry, labelled `takes:implement`: an `/implement` session lands it by running `manual-sync` in full.

### 4. Write back into §B — mandatory, before the pass closes

Any restatement the search leg found that §B did not list is added to the entry. **A coverage table reporting found-but-unlisted restatements with no §B edit in the same commit is a failed pass.**

### 5. One adversarial subagent, accusing in both directions

It never edits; it accuses. It names **un-made edits *and* edits that reached past the fact** — over-reach counts against the result.

**It may reopen the loop exactly once. A second reopen is a handback, not a third round** — the work goes back to `/wayfinder` or `/to-tickets`.

### 6. Audit trail

- A **coverage table** — one row per §B entry with a touch/no-touch verdict and reason; one row per §A group dismissed by class; the write-back list.
- **The adversary's accusations in full, including the ones the pass rejected and why.**

A sealed expected-hits list is **not** a per-pass requirement: it tests the mechanism rather than the run, it would make the founder the bottleneck on every document update, and it cannot cover a fact whose blast radius is not yet known.

## Capture and placement — where a settled fact goes

A durable fact has **two properties, bought separately** — durability (a versioned repo home) and retrieval (whatever makes a session read it at the moment it matters).

### 1. File it in the same session — there is no holding step (mantahostels#2748)

The fact goes straight into the document steps 2 and 3 select, written by the session that settles it.

The test for writing anything at all is **whether a future session would act differently for knowing it**.

**Where the destination is the ticket itself** — the fact's subject is the repo's own machinery and its owner document is always-loaded, so `CLAUDE.md` §Ground truth sends it to the settling ticket — the record is a comment on the issue you are working, opening with the marker line and stating the fact in plain prose:

```
**Captured fact:** <the fact, in plain prose>
```

Nothing else — no type, no frontmatter, no `Why:` / `How to apply:` pair. That comment **is** the filing, so the session marks it consumed in the same breath — `node scripts/capture-drain.js mark <comment-id>`, which owns the reaction's spelling. **Unenforced** (mantahostels#2748): `scripts/check-capture-drain.js`'s age line on `npm run status` is the only thing that catches a miss.

**Every other fact goes to a document, and there is no third place.** No existing document owns it → create one under step 2, with its trigger line. No ticket open to comment on → open the issue the fact belongs to rather than leaving it in a comment nobody will route.

A **load-bearing** fact about the project's world keeps its own route, `CLAUDE.md` §Ground truth's §B rule.

**Check the destination for an existing statement of the fact as you file it** (mantahostels#637).

**The drain is the residue loop, not the routing loop** (`.claude/skills/capture-drain/SKILL.md`): it finds captures that escaped this rule by their marker and routes each under steps 2 and 3.

### 2. The body goes to the document that owns its subject (mantahostels#639)

Existing documents first. A **new** document is allowed where no existing one owns a coherent cluster — but only ever created together with its trigger line, never on its own.

### 3. Retrieval is bought separately, by the cheapest trigger that reaches the sessions that need it (mantahostels#639)

**Run the placement test in order; the destinations below are what it selects among** (mantahostels#1720). **Letters are frozen** — cited by letter across the repo — so a destination is added as a new letter, never renumbered (mantahostels#1245). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->

**Step 1 — is it a rule?** A rule constrains an action a session might otherwise take wrongly. A value to look up is not: that is (d).

**Step 2 — name the trigger.** The *nearest* observable event preceding the decision the rule binds — a tool call, or class of calls, expressible as a hook matcher plus a command test (mantahostels#3421). **Session start or prompt time — routes (a), (b), (c) — satisfies this step only where it is that nearest event**, as for a rule binding before the first tool call (mantahostels#2501 measured the miss otherwise). **No nameable trigger → (c), the always-loaded pool, whatever the arithmetic says** (mantahostels#1639). That is the pool's only entrance. `docs/working-contract.md`'s rules pass it: they bind before a reply is written, a moment no matcher reaches. **A pool rule whose decision is visible in the finished reply also takes a `Stop` check** — `scripts/guard-priced-options.js`'s shape. **Answering this step is gated wherever the answer lands bytes in the pool** — §5's trigger verdict (mantahostels#1788).

**Step 2 is answered per rule as the admission test (workflow-core#1942).** Every top-level list item and bold-led paragraph an always-loaded file carries, outside fences and HTML comments, has an entry in `docs/pool-admission-ledger.json` (workflow-core#2033, workflow-core#2056): its removal claim, the wrong act a session takes without the rule, and its route — `no-trigger`, `trigger` with the `/implement` ticket whose guard will print it, or `pre-first-tool-call`. A rule a guard already prints at the moment it bites leaves the pool whole, its marker and citations going to `docs/agents/guard-registry.md`. A rule with a trigger but no guard printing it stays until one does. A rule that stays keeps one marker and the one path or issue `scripts/check-guard-registry.js` needs, and a residual clause only where it names an act. Where `.claude/workflow-core.json` sets `admissionGate`, `scripts/check-context-budget.js --against HEAD` refuses a commit adding a pool rule with no ledger entry.

**Step 3 — to choose, or only to be stopped?** Needed to choose correctly → (f). Needed only to refuse the wrong choice → (e). Both → both, from the same hook. **(f) misses the first occurrence**: injected `additionalContext` lands with the triggering call's result, after that call has run. **Where a first breach cannot be undone, take (e) and (f) from the same hook** (mantahostels#3421). **Behavioural, never topical** (mantahostels#886): read the mechanism's real output first.

**Step 4 — reach.** A trigger reaching only subagents puts the rule in the dispatch prompt. A skill body takes procedure alone (mantahostels#1757).

**Fail-open is disqualifying.** A surface that can silently reach nobody carries no binding rule — which bars `.claude/rules/` `paths:` frontmatter (mantahostels#1717: no hook in the path, documented silent fail-open) and skill bodies, and demotes (g).

**The test binds prospectively** — every new rule, every relocation (mantahostels#1787).

Destinations, in preference order:

- **a. The skill file that runs when the fact bites** (`.claude/skills/<skill>/SKILL.md`). Preferred wherever a fact only bites inside one skill's loop.
- **b. Text pasted into the tracker injector's header, in `scripts/lib/tracker-inject-text.js`**, reaching its seven commands — `/wayfinder`, `/to-spec`, `/to-tickets`, `/implement`, `/triage`, `/card-close`, `/code-review`. For a fact that bites only in tracker work: a fact biting any session under-reaches here. `/code-review` takes the header's per-command block alone, so a rule meant for it goes in that arm. **Binding rules are placed here** (mantahostels#1916). **The budget is per command, not one number**: only the per-command blocks vary, so a rule placed in one arm spends none of another's margin. Read all seven live from `node scripts/check-injector-margin.js`, against the harness's 10,000-character persistence threshold; the pre-commit dispatcher runs it on any commit staging the injector or a rule fragment it reads, and refuses at the threshold (mantahostels#1915). §4's union cap binds every placement on top of that. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->
- **c. A pointer line in an always-loaded file** — a member of §4's pool. For a fact whose relevance a session cannot predict from the work in front of it. The line names the trap and points at the body; it never restates it.
- **d. Nothing at all.** For reference material a session finds when it goes looking — the §B class, and research linked from its issue. Legitimate where the fact is a value to look up rather than a trap to avoid.
- **e. A guard that reprints the text when it fires.** Bytes whose operative instruction a guard reproduces verbatim at the moment it bites are already retrieved, so the rule owes no shed for them. **The test is behavioural, not topical:** a session meeting only the guard's output must be able to act correctly without the cut bytes, so the session claiming this route reads the guard's actual output before cutting (mantahostels#886). **That test is a prediction, and §5 carries its verdict**: a tranche shedding on this route writes the claim into its ledger entry, and the tranche after it records whether the guard has since fired (mantahostels#1719). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->
- **f. A guard that injects the rule on the call it governs**, read with that call's result (step 3). The same `PreToolUse` hooks as (e), emitting `additionalContext` on the clean branch rather than a denial on the wrong one, through a core's `injectRules` decision, which `scripts/lib/guard-entry.js` latches and caps; rule bodies live in `docs/agents/rules/` (mantahostels#1717). **The billed unit is the SESSION, not the event** (mantahostels#2046). The kit latches per (rule, agent, session), so an id is delivered once in a top-level session's life however many events could carry it, and once again in each subagent it dispatches; what a session can be made to pay through one tool is the sum of the **distinct ids** every guard that tool wires can reach. The harness persists **10,000 characters per hook entry** ([docs/research/hook-payload-persistence.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-payload-persistence.md)), and `self-plugin/hooks/hooks.json` gives each guard one, so `RULE_CAP` (4,000 B, enforced inside `guard-entry.js`) is the whole of the truncation guarantee.
- **g. A pointer, in (b)'s header, to a named section of `docs/agents/issue-tracker.md` or `docs/agents/triage-labels.md`.** Neither document is pasted, so the bytes reach only the session that opens the section. ⚠ **Demoted: no new binding rule here** (mantahostels#1916). Its follow-through is the fail-open the test above disqualifies (mantahostels#1869). What belongs here is reference material, and rules whose miss a guard turns into a denial. **It does not reopen on a re-measurement**: only a mechanism that makes a session read the section rather than choose to puts it back in contention. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->

**Route (f) takes two caps, on independent axes** (mantahostels#1720). **Both are priced at the spelling an adopter's install receives** (`scripts/lib/install-probe.js`, workflow-core#5447). The first is **34,000 B per session per `PreToolUse` tool** — a **context-cost ceiling, never a truncation guarantee** — the largest live group, `Bash` at 33,577 B across 41 ids in a linked worktree, rounded up past a 423 B slack band (workflow-core#5447). `scripts/check-context-budget.js`'s **OVER-SESSION** assertion holds it (mantahostels#2004): it reads the live wiring, prints the per-tool figures on `npm run check:context`, and refuses a commit that raises an already-over-cap group.

The second is **a shared ratchet across all triggers** — the union of every reachable id across every tool, one fragment counted once however many guards or tools reach it — at **57,000 B**: 56,878 B across 70 ids measured on the session unit, rounded up past a 122 B slack band (workflow-core#5447). **Neither cap's live headroom is stated here** (mantahostels#2272) — read both off `npm run check:context`. **The seed is never set below the measurement**, which would be §4's downward-only ratchet. **It is not retired**: the per-tool cap would permit its whole figure on each wired tool, and the union is what a session actually pays.

**Rule text a hook hands over after its call has run — on `PostToolUse`, `PostToolUseFailure` or `PostToolBatch` — is measured and uncapped** (workflow-core#2144). `npm run check:context` prices it as it prices route (f), a latched id once a session and an unlatched one on every firing, and puts it on neither cap: both were seated on `PreToolUse` measurements, and no figure has been seated for this surface.

### 4. The always-loaded budget binds trigger lines, not facts (mantahostels#639, mantahostels#666)

No fact's *body* sits in an always-loaded file unless it must be read before *any* tool call; everything else takes a pointer to an on-demand body, and a new always-loaded body is priced in §5.

That residual is capped at **22.5 KB** — **a shared pool, not a per-member budget** — and **a tranche leaving the pool at or over that cap names the shed that pays for its bytes, in the same commit. Under cap no shed is owed; the tranche prices itself instead**, its §5 entry carrying the bytes added and the headroom it opened and closed (mantahostels#2036). **Headroom is spendable**: a shed owed below cap would make every addition net-zero-or-below — a downward-only ratchet (mantahostels#1220). The pool is not first-come, parallel sessions being the default here, and takes no per-file caps, which would freeze an arbitrary split between the members. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->

**What the pool covers is a test, not a list (mantahostels#1235, narrowed at mantahostels#1503): bytes in *every top-level* session's context before any work, that *this repo can delete*.** A subagent is not top-level; its own dispatch is priced where it is made. Three members pass it:

- **The files `.claude/workflow-core.json`'s `alwaysLoaded` declares** — here `CLAUDE.md`, `docs/working-contract.md` and `.claude/output-styles/core-voice.md` — in bytes on disk, read by `scripts/lib/always-loaded-pool.js`. The voice contract is **counted once**, as the active output style; it counts twice only while an always-loaded file also `@`-imports it (mantahostels#1503). A subagent therefore gets no voice, accepted at workflow-core#1942 because it reports to its parent, never to the founder. **A background job is a top-level session, not a subagent.**
- **Own skill and command frontmatter `description` values**, **except where the startup listing never delivers the description**. A skill carrying `disable-model-invocation: true` is absent from the listing (mantahostels#1757); a `"name-only"`, `"user-invocable-only"` or `"off"` entry in `.claude/settings.json`'s `skillOverrides` drops the description alone (mantahostels#1786) — and being a settings key it reaches vendored skills too, whose frontmatter edits the next pull reverts. An unsilenced file with no `description` key is listed under its body's first non-blank line, heading marker stripped and cut at 100 characters, and is charged that line (workflow-core#2054). **The surface grows by skill count, never by inflating an existing description**, so a pool contribution is the instrument and a per-description length limit is not (mantahostels#1235).
- **Agent definitions** (`.claude/agents/*.md`) — their **`name` and `description` only**, never their body.

**Two adjacent surfaces are measured and uncapped — excluded from the cap, never from governance** (mantahostels#1235).

- **Vendored skill descriptions**, in **delivered bytes**: a silenced description counts 0 B. They fail the *deletable* limb at byte granularity — symlinked from `.agents/skills/`, so one can be dropped whole while an edit to one is reverted by the next pull unless declared in `.agents/vendored-skill-edits.json` (mantahostels#1826). No cap exists because **no candidate number exists**: the set is an outside vendor's, and today's total is a snapshot of it (mantahostels#1260). **Adopting a new vendored skill names its description bytes — delivered, so 0 B where it lands silenced — in the adopting commit's message.** **Unenforced** (mantahostels#1260): nothing prompts an adopting session to look. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->
- **Plugins** — `claude plugin details <name>`'s Always-on token figure, quoted in the enabling commit message, read by `check-context-budget.js` from `.claude/plugin-context-cost.json`, which WARNs on an enabled plugin with no row rather than pricing it at zero (mantahostels#3116). No commit is refused on this surface: the plugin bytes live outside the repo.

**The vendor / wrap / write-locally ladder governs what adds to either** (mantahostels#1172, extended to plugins at mantahostels#2971). Reach for the cheapest primitive that can carry a repo-specific rule: (1) a script or hook; (2) a rule line in the document that already owns the surface; (3) a local skill, whose description enters the pool; (4) a wrap of a vendored skill, only where the upstream body is worth more than the wrapper costs; (5) vendoring, only where the skill needs no repo-specific rule in its body. **A plugin is rung 5 with one more condition**: the repo needs none of it edited and pays its whole always-on cost, a subset being a fork. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->

**The injected tracker docs** fail the *every session* limb — `scripts/inject-tracker-docs.js` fires on seven commands, in ~41% of sessions ([docs/research/tracker-injection-frequency.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md)) — and take **their own cap, 10,500 B**, over the union of every payload string the script can emit, whichever command takes it (mantahostels#1284, mantahostels#1817). The priced-options shape enters the union as its Core voice pointer; a host whose style is not Core voice gets the whole shape, bounded by the per-command assertion below (workflow-core#2039). **This cap is not the limit that binds** (mantahostels#1901): the harness persists an injected payload inline only under 10,000 characters per command, which `scripts/inject-tracker-docs.test.ts` asserts and §3 route (b)'s margin script prints. The cap watches aggregate drift across strings several commands share, which no per-command assertion sees. **A span relocated out of `docs/agents/issue-tracker.md` or `docs/agents/triage-labels.md` into the header is not a shed**: the same bytes reach the same payload.

**Both values are ratchets against drift, not reopened on price alone (mantahostels#1220, mantahostels#1235).** The pool's **22,500 B** is the pool as measured on 18 October 2026, 20,334 B (workflow-core#2034), rounded up past a band sized on the largest upward move between adjacent daily samples of its three files since 25 August, +1,813 B on 28 August — the gate being per-commit, the band has to survive the largest ordinary day (mantahostels#1662's method). The +9,941 B of 18 September is left out of the band: core-voice joining the pool was a scope change, which the scope trigger prices. The injection's **10,500 B** is the union as measured on 18 October 2026, 9,637 B (workflow-core#2039), rounded up past the same method's band: +515 B on 6 September, the largest upward move between adjacent daily samples of the injector and its rule fragments from 29 August, the first day whose own tree the checker reads. **A KB in the pool is priced, and neither threshold is derived from the price**: a price is linear in bytes, so it has no knee. The currency in which a threshold *would* be coherent is **dilution** — what a KB costs is compliance with the rest — and it has no instrument (mantahostels#1159).

**Three things move the pool's value; a fourth reason is a new question, not a reopening.** **Cite a trigger by name, never by ordinal: striking one renumbers the rest** (mantahostels#1245). **(i) the scope trigger** — the pool's scope changing bumps or cuts the value by exactly the bytes folded in or out, so the change is always scope-neutral (mantahostels#1235, mantahostels#1284); **(ii) the price trigger** — the price moving by more than ~2×; **(iii) the unpayable-correction trigger** — a correction to a false rule that can name no shed (mantahostels#1221, below). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->

**Restated in:** `scripts/check-context-budget.js`'s `CAP_BYTES`, `INJECTION_CAP_BYTES`, `SESSION_CAP_BYTES` and `RATCHET_CAP_BYTES` and its header, `scripts/check-context-budget.test.ts`'s `CAP` and `INJECTION_CAP`, and the gate in `.husky/pre-commit`. Re-measure at the time of use rather than trusting any figure written here — `node scripts/check-context-budget.js` prints every surface.

The cheapest shed is a rule whose **full body already exists** behind a live trigger, so relocating it to a pointer rewrites nothing and creates no document. The accepted cost is that a session reaching that rule by another route meets the guard's denial without the escape route in front of it.

**The ratchet fires on net bytes, so subtraction is the first move on a false rule.** A tranche measuring net zero or below adds no always-loaded bytes and owes nothing. Rewriting a false sentence true is usually cheaper than appending a qualification to it (mantahostels#1046). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (workflow-core#803) -->

**The ratchet gates `.husky/pre-commit`, on direction rather than level (mantahostels#1224).** A commit is refused when its staged bytes leave either capped surface at or over its cap **and** larger than at HEAD; an over-cap total the commit did not increase stays a WARN. Both totals are read from git, HEAD against the index, never off disk. **Two routes past a refusal and no third, there being no escape variable:** shed the bytes in the same commit, or move the cap by editing this section, which is the unpayable-correction trigger firing. Shed candidates: `docs/research/always-loaded-shed-candidates.md` for the pool, `docs/research/injected-tracker-docs-shed-candidates.md` for the injected docs.

**A correction to a currently-false rule owes a shed like any addition (mantahostels#1221).** **A falsity correction takes first claim on the standing shed candidates**, ahead of any tranche adding a new rule, and **a correction that can name no shed escalates** — the unpayable-correction trigger — rather than landing unpaid.
