#!/usr/bin/env node
/*
 * check-doc-map.js — CI guard that docs/doc-map.md still covers the repo.
 *
 * Usage:
 *   node check-doc-map.js [<doc-map.md>] [--data-dir <dir>] [--root <dir>]
 *                          [--map-dirty]
 *   (default: docs/doc-map.md; data dir defaults to the map's own directory)
 *   --root relocates both defaults into a materialised tree — see the block
 *   below the assertion list.
 *   --map-dirty overrides assertion 11's own git check — see the note
 *   at assertion 11 below.
 *
 * doc-map.md Section A assigns every in-scope file an authority class — who may
 * edit it and by what route. That only works if it is complete: a document with
 * no register entry is a document the update routine will never consider, and
 * nothing else in the repo notices.
 *
 * Numbered 1..33: the numbers are cited by name across this repo and its
 * closed issues, so an assertion keeps its number (mantahostels#1665).
 *
 *   1. Coverage — every tracked file under the mapped scope matches at least one
 *      key in docs/doc-map-classes.json or lib/doc-map.js's CORE_CLASSES
 *      (#428). Uncovered files FAIL, naming
 *      register-doc.js and the command that clears it, unless the file itself
 *      landed within the pairing grace window (mantahostels#1785, `PAIRING_GRACE_MS` in
 *      lib/doc-map.js) — a split commit pair WARNs instead until the window
 *      expires. The SIDECAR is the coverage authority since mantahostels#1849, not §A's
 *      rows: §A is rendered from it (assertion 17), so a row is a projection
 *      and a projection cannot be the register. A sidecar that is absent or
 *      will not parse is BROKEN, on the restatement file's reasoning (mantahostels#591) —
 *      "cannot read the register" is never "everything is covered". Absent
 *      from a `--data-dir` copy, the tracked docs/doc-map-classes.json answers
 *      instead — `readMapTextAt`'s fallback (mantahostels#1191), said out loud where it fires.
 *      .husky/pre-commit stages the sidecar out with the map, so that caller
 *      does not take the fallback and a DELETED key is refused like any other
 *      fault: the direction gate needs the two readings to differ, and a single
 *      working-tree file read on both sides can never make them.
 *   2. No dead entries — every register path matches at least one tracked file.
 *      A path absent from the filesystem too — a genuine rename or delete —
 *      FAILs, so the map cannot quietly describe a repo that no longer exists,
 *      unless the register row itself is within the same grace window, which
 *      WARNs (mantahostels#1785). A path that exists on disk but is merely untracked WARNs
 *      regardless of age (mantahostels#1193): the register edit and the file's own commit
 *      are separate steps, so this is normal mid-ticket state, not drift, and
 *      it must not block an unrelated commit in the shared working tree.
 *   4. Live routes — every path a Section C route sends the reader to exists.
 *      A dead one FAILs (mantahostels#212); one present on disk but merely untracked WARNs,
 *      on assertion 2's reasoning (mantahostels#1403). Stricter than assertion 2 in one
 *      place, deliberately: a GITIGNORED target FAILs here and WARNs there, the
 *      untracked set coming from `git ls-files --others --exclude-standard`
 *      rather than existsSync — nothing will ever commit an ignored file.
 *      Alongside it, the in-scope files no route
 *      reaches are listed and never gate: a hard fail would force a route onto
 *      every binary asset (mantahostels#22).
 *   5. Live restatements — every path in docs/doc-map-restatements.json, the
 *      data file Section B's restatement lists now live in, exists. A dead one
 *      FAILs (mantahostels#213); a missing or unloadable data file is BROKEN (mantahostels#591).
 *      Run from a plugin install, 4, 5 and 25 also accept a file the plugin
 *      root ships (#604).
 *   6. Distinct entry ids — no two `### B<n>` headings carry the same n. A
 *      duplicate FAILs (mantahostels#970), and is uncorrectable afterwards: ids are
 *      permanent (mantahostels#892) and four sidecars key off them.
 *   7. Dense route ids — the `### C<n>` headings run C1..C<highest> with no
 *      gap, no duplicate and no leading zero. A breach FAILs (mantahostels#1229).
 *   8. Distinct register keys — no key appears twice in
 *      docs/doc-map-classes.json's own bytes. A repeat FAILs (mantahostels#1402, moved off
 *      §A's rows at mantahostels#1849): a key is its arbiter region id (`A:<path>`,
 *      lib/doc-map-regions.js), so a repeat hands two entries one lock and puts
 *      their writers back in the contention the split ended. Read from the raw
 *      text, never the parsed object: `JSON.parse` keeps the last of a repeated
 *      key and drops the rest silently, so the fault is invisible to every
 *      reader that walks the parse — assertion 6's reason for counting raw §B
 *      headings.
 *   9. No stray entries — every `### B<n>` heading sits inside the Section B
 *      range. One appended past `## Section C` is named by id, and its words go
 *      uncounted in the §B word total scripts/report-doc-map-budget.js measures
 *      against the budget (mantahostels#1352). FAILs (mantahostels#1352, mantahostels#3525).
 *  10. A `Settled at` bullet on every entry. One carrying none FAILs (mantahostels#1458).
 *  11. Pointer-shape agreement (mantahostels#1474). A `Restated in` or `Supersedes` bullet
 *      matching none of the three fixed templates FAILs; a stated `<n>` unequal
 *      to its sidecar key's `paths` length FAILs; a pointer naming a key the
 *      sidecar does not hold FAILs, as does a `Supersedes` bullet with no key or
 *      a superseded key with no bullet. A `Retired vocabulary` bullet's
 *      free-text phrase count is held to the same rule (mantahostels#2293): a stated `<n>`
 *      unequal to its sidecar key's `phrases` length FAILs, and a bullet
 *      stating no count at all FAILs — but an entry the sidecar does not key is
 *      silent here. A fault WARNs rather than FAILs where docs/doc-map.md
 *      itself differs from HEAD
 *      (mantahostels#1193): a dirty map is a live session mid-edit, and the sidecar is
 *      written alongside it, so a disagreement is that step not having run
 *      yet. Against a clean map the same fault is still FAIL. `--map-dirty`
 *      exists because that git check cannot run against `<doc-map.md>` for
 *      every caller — see the comment where it is read, below.
 *      The templates themselves are in docs/doc-map.md §B's preamble.
 *  12. New ids above the mark — a `### B<n>` id ABSENT from HEAD's copy of the
 *      map must sit above the high-water mark, `highWaterMark` in
 *      docs/doc-map-high-water.json, the highest id ever removed, or FAIL
 *      (#2339): ids are permanent (mantahostels#892), so a reused one makes a
 *      stale reference resolve to the wrong entry. Added only, on assertion
 *      14's discriminator, and silent where HEAD holds no copy of the map.
 *  13. The mark holds — every id HEAD's map holds and this one does not sits
 *      at or below the mark, and the mark sits at or above HEAD's, or FAIL: a
 *      removal that leaves the mark below its id, or a lowered mark, lets a
 *      later commit reuse an id. A missing or unloadable mark file is BROKEN.
 *      Neither 12 nor 13 is softened by `--map-dirty`: the commit adding or
 *      removing an entry always has a dirty map.
 *  14. New-entry prose cap — a `### B<n>` id ABSENT from HEAD's copy of the map
 *      must carry 300 prose words or fewer, or FAIL (mantahostels#1384, on mantahostels#1350's ruling).
 *      Added only: an entry this commit merely edits is untouched, so a
 *      one-word correction to a fat entry still costs nothing — the on-touch
 *      scope mantahostels#1311 refused. It is the one
 *      assertion `--map-dirty` must NOT soften: the commit adding the entry is
 *      exactly the dirty-map case, so softening it would refuse nothing at all.
 *      Silent where HEAD holds no copy to compare against — a first commit on a
 *      fresh checkout — because "cannot tell which are new" is not "none are".
 *  15. Shed-ledger entry cap — every bullet in §Capture and placement §5's
 *      `Sheds paid, most recent first:` list EXCEPT the newest is at or under
 *      `LEDGER_ENTRY_CAP_BYTES`, or FAIL (mantahostels#1640). A tranche is written in
 *      full only while it
 *      is the newest; the tranche that displaces it compacts it to its issue
 *      number, its date, its net byte figure, what it did in one clause, and
 *      its named residual — plus, where the displaced entry carried a
 *      prediction, its verdict, a conditional sixth element sitting beside
 *      that residual, never inside it (mantahostels#1864).
 *      Like assertion 14 it is NOT softened by
 *      `--map-dirty`: the commit that lands a tranche is exactly the dirty-map
 *      case, so softening it would refuse nothing. The sibling
 *      `Rejected, with the residual reason:` list is out of scope — it is
 *      already in the shape this cap enforces. Silent where
 *      the stem line is absent, which is "not the doc map", not "no ledger".
 *  16. Trigger verdict on a pool-byte tranche — a commit that ADDS bytes to
 *      docs/doc-map.md §Capture and placement §4's whole-file always-loaded members
 *      must leave §5's ledger a NEW newest entry carrying a
 *      `**Trigger:**` verdict, or FAIL (mantahostels#1788). The verdict is the answer to
 *      the placement test's step 2 (§3): the trigger the rule binds behind, or
 *      the words recording that none exists. Like assertions 14 and 15 it is
 *      NOT softened by `--map-dirty`.
 *      Silent where no committed rev resolves, or where the map carries no
 *      ledger stem: "cannot tell whether this commit adds pool bytes" is not
 *      "it adds none". A git that will not answer is BROKEN (#3152). An entry is known by its label, its `#<n>` and one
 *      lowercase word directly after it, so a second tranche under one issue
 *      labels itself apart (`#<n> review`, #1739). Two residuals it cannot
 *      see: a parallel session's fresh entry satisfies your tranche, and
 *      relabelling HEAD's newest entry reads as a new one.
 *  17. §A render agreement — §A's bytes must be what
 *      generate-doc-map-section-a.js renders from docs/doc-map-classes.json.
 *      A hand-edited row FAILs (mantahostels#1863, on mantahostels#1808's ruling that §A becomes a
 *      projection), naming the paths whose rows differ and the regeneration
 *      command. NOT softened by `--map-dirty`, for assertion 14's reason.
 *      Silent, and said out loud, where §A carries no register table for the
 *      renderer to place rows into. An absent sidecar is BROKEN at load,
 *      above assertion 1 (mantahostels#1849).
 *  18. Role prose cap — a `role` override in the sidecar must carry 300 words
 *      or fewer, or FAIL (mantahostels#1863), in assertion 14's shape. Unlike 14 it is not
 *      added-only: §A's rows are generated, so an override is edited in the
 *      sidecar and there is no "first commit" to scope to. Also not softened
 *      by `--map-dirty`.
 *  19. Class vocabulary — every sidecar entry's `class` is one of the five
 *      documented tokens (docs/doc-map.md §Authority classes). A typo FAILs
 *      (mantahostels#1849), naming the path and the token, rather than minting a sixth
 *      value; `classQualifier` is where a dual-class judgement goes and is not
 *      checked against a vocabulary. It reads the raw parse, because
 *      `loadDocClasses` THROWS on this fault and a throw is BROKEN — apparatus,
 *      not a finding a session can fix. Assertions 17 and 18 are skipped and
 *      said to be skipped while one stands: there is nothing sound to render.
 *  20. Compaction verdict — where this commit compacts the entry that was §5's
 *      newest at HEAD, and HEAD's copy of it carried a `**Prediction` marker,
 *      the compacted form must carry a `**Verdict` marker OF ITS OWN with at
 *      least TRIGGER_VERDICT_MIN_WORDS words after it, or FAIL (mantahostels#1968, on
 *      mantahostels#1890's ruling). A marker reading `**Verdict on #<other>` is another
 *      entry's verdict written onto this one — the mantahostels#1966 breach — and is
 *      skipped rather than counted. The word count runs to the end of the line
 *      or to the next bold element, whichever comes first, so an empty verdict
 *      cannot borrow the residual's words. NOT softened by `--map-dirty`, for
 *      assertion 15's reason. Reads HEAD alone, never readCommittedRevs(): a
 *      second parent would NARROW this one, refusing a merge for a compaction
 *      the other branch committed. Three residuals are outside it deliberately — a
 *      missing prediction, a verdict that is STALE rather than absent, and a
 *      sixth element that is not a verdict.
 *  21. Stale over-cap marker — a §B entry carrying a top-level
 *      `- **Over cap by ruling (#n):**` bullet — an indented echo of those
 *      words is not a marker and is invisible to 21 and 22 alike (mantahostels#2058) —
 *      that now reads at or under the 300-word cap FAILs: the marker
 *      asserts the entry cannot reach the cap without dropping a claim, and a
 *      fallen entry makes that assertion stale. Read over every §B entry, not
 *      the over-cap ones, which a fallen entry has dropped out of. NOT softened
 *      by `--map-dirty`, despite what mantahostels#2058 asked: the marker goes stale in
 *      exactly the commit that drains the entry. Safe unsoftened because the
 *      fault sits in the `data` envelope, so checker-new-faults.js reads a
 *      fault already at HEAD as inherited and never refuses an unrelated
 *      commit.
 *  22. Over-cap entry growth — a §B entry carrying that same marker may not
 *      GROW against its baseline, which is HEAD PLUS a merge's other parent,
 *      largest count winning — never HEAD alone, unlike assertion 20
 *      above (mantahostels#2050's review, `readParentRevs()`). Two skips, both in
 *      `grownExemptEntries`'s own header: an entry back at or under the cap,
 *      which is assertion 21's, and an entry unmarked at the baseline, so the
 *      commit first writing the marker is not warned for writing it.
 *      WARN, never FAIL, so it stays out of
 *      `count`, out of the `data` envelope — where it would refuse a later
 *      commit by the back door — and out of the OK line it would contradict.
 *      .husky/pre-commit replays this block by name on a green run, since it
 *      otherwise prints the report only on a non-zero exit. Silent, and said to
 *      be silent, where HEAD holds no copy to compare against.
 *  23. Malformed over-cap marker — a §B line opening with the marker's words
 *      but failing its spelling, in an entry carrying no valid marker, WARNs
 *      (mantahostels#2124). WARN, never FAIL, on assertion 22's terms — the call site's own
 *      comment carries why.
 *      Replayed by .husky/pre-commit on a green run, as assertion 22's is. The
 *      probe catches a punctuation, emphasis, case or hyphen slip and NOT a
 *      misspelling of the words themselves — `EXEMPTION_MARKER_NEAR_MISS`'s
 *      own header holds that residual.
 *  24. Dropped over-cap marker — a §B entry the baseline marked, still over the
 *      cap, carrying no valid marker now WARNs (mantahostels#2227). Baseline is HEAD ALONE
 *      and NOT 22's `readParentRevs()`; `droppedExemptionMarkers`'s own header
 *      carries why, its three skips and its two residuals. WARN on 22's terms
 *      — out of `count`, out of the `data` envelope, replayed by
 *      .husky/pre-commit on a green run. Silent where HEAD holds no copy, and
 *      says so in its own line.
 *  25. Live Consumes references — every TYPED reference in a sidecar entry's
 *      `consumes` list resolves (mantahostels#2419). In assertion 4's shape and for its
 *      reasons: a `path` naming no tracked file and nothing on disk FAILs, one
 *      present on disk but untracked WARNs, and the whole block softens to
 *      WARN under `--map-dirty` on assertion 11's reasoning. A `glob` matching
 *      no tracked file FAILs; a `figure` naming no live §B id FAILs; an
 *      `issue` is checked for shape and NEVER resolved over the
 *      network; `external` and `note` are never resolved; an unknown `kind`
 *      FAILs. A `consumes` that is not a list is a shape fault rather than a
 *      skip. Reads the raw parse, as assertion 19 does, so a
 *      malformed reference is a named finding rather than a BROKEN run, and
 *      stands `loadDocClasses` down with it on assertion 19's reasoning.
 *  26. Pair-scope prefixes — a `consumes` gloss opening `with <other-ref>: `
 *      names the reference immediately before it in the same cell (mantahostels#2647),
 *      the form §A's preamble sets for a gloss covering the bare reference
 *      beside it. Only the prefix's referential integrity is checked — whether
 *      a gloss OUGHT to be pair-scoped is intent, and no assertion reads it.
 *      Never softened by `--map-dirty`; the reason is at the site.
 *  27. No line-number locators — no `L<n>` token (mantahostels#3151) and no `<file>:<n>`
 *      citation (mantahostels#3160) in a restatement path's `locator` or `gloss`, an
 *      entry's `note`, or a §B entry's own prose. Never softened by
 *      `--map-dirty`: a half-written entry carrying one is refused too.
 *  28. Live anchors — a `locator`'s straight-double-quoted phrase is held
 *      byte for byte in the file the path names (mantahostels#3151). A path assertion 5
 *      already reports is skipped here, and so is one the suffix match
 *      resolves to more than one file. Not softened by `--map-dirty`.
 *  29. Admission record — a `### B<n>` id ABSENT from HEAD's copy of the map
 *      must carry a conforming row in docs/doc-map-admissions.json, or FAIL
 *      (mantahostels#3225, on mantahostels#2888's design). The row names the settling issue, what the
 *      founder answered, and the permalink of the comment recording it; the
 *      checker reads presence and field shape OFFLINE and never fetches the
 *      URL. Added only, on assertion 14's discriminator: an entry already in
 *      HEAD was admitted before this commit. It is the second assertion
 *      `--map-dirty` must NOT soften, for 14's reason — the commit adding an
 *      entry always has a dirty map. Silent where HEAD holds no copy to
 *      compare against.
 *
 *  30. Sidecar canonical serialisation (mantahostels#3353) — docs/doc-map-classes.json's
 *      tracked bytes must equal its own parsed content reserialised the way
 *      register-doc.js writes it (top-level keys sorted, tab-indented,
 *      non-ASCII left unescaped, one trailing newline). Pins only the
 *      TOP-LEVEL key order and the file's own bytes: an entry's internal
 *      field order is unpinned, and a sidecar carrying a duplicate key (8's
 *      fault) can never pass this one either — JSON.parse silently drops the
 *      repeat, so no such file can equal its own reserialisation.
 *  31. Reader vocabulary (mantahostels#3412, ruled at mantahostels#3348) — every `.md` and `.html`
 *      sidecar key carries `reader`, one of `agent`, `human`, `both`, and no
 *      other key carries one. UNKNOWN-READER, MISSING-READER and
 *      READER-ON-NON-PROSE all FAIL off the raw parse, in assertion 19's
 *      shape, and an unknown token stands loadDocClasses down with 19.
 *      Never softened by `--map-dirty`: a sidecar value is a whole judgement.
 *  32. Page source (mantahostels#3412) — a documentation page key (`derived`, `.html`,
 *      `consumes` naming a `.md` path) FAILs where its source has no key of
 *      its own or is read by `agent` alone (docs/doc-pages.md §Which
 *      documents). Not softened by `--map-dirty`.
 *  33. Live section references (#805) — every `docs/doc-map.md §<name>`
 *      reference in a tracked file names a heading of the map, by the rules
 *      in `isLiveSectionRef` (lib/doc-map.js); an unresolved one FAILs, and so
 *      does a bare `§<n>` two `### <n>.` headings share. Skipped:
 *      `binary-asset` files, which hold no prose, and test files, whose
 *      strings are fixtures. Not softened by `--map-dirty`: a section the commit deletes
 *      is the fault. Residuals: a `§X preamble` wrapped onto a second line
 *      reads as plain `§X`; a reference running to its line's end passes on
 *      any words that open a heading's name (`§The`); the path is not seen
 *      prefixed `./` or `../`, possessive, inside a link or in bold; and
 *      .husky/pre-commit runs this checker only on a commit staging its
 *      mapped scope, so a dangling reference added under `scripts/` alone
 *      waits for the sweeps.
 *
 * WHERE IT RUNS — two places (mantahostels#390): .github/workflows/roadmap-digest.yml,
 * on the four daily sweeps and on no push at all (mantahostels#910); and .husky/pre-commit
 * for a commit touching the mapped scope, silent on success and replaying the
 * whole report on failure.
 *
 * WHAT ASSERTION 5 READS: the `path` of every item in
 * docs/doc-map-restatements.json, keyed by entry id, so a dead path is still
 * named against the entry that owns it. Existence, never completeness (mantahostels#213) —
 * and a path left only in an entry's surviving prose is read by nothing
 * (mantahostels#590).
 * Section A's stale-copy pointers and the stamp table's `Cited by` column are
 * read by no assertion at all, deliberately: a file vanishing from a stale-copy
 * pointer is the drift resolving, not a fault.
 *
 * The bare-locator warning scopes to prose-held paths — Section A's rows and
 * Section C's routes. Write a locator with its filename, never bare: a
 * backticked line-list on its own holds a slash and reads as a dead path.
 *
 * The stamp line is still parsed, as the canary that the file handed in is the
 * map at all — it carries a version and a date, both judgements (mantahostels#845).
 *
 * Take a new entry id from
 * `node scripts/session-arbiter.js alloc-entry docs/doc-map.md`, which allocates
 * it atomically and claims the append slot with it (mantahostels#970) — assertion 6's
 * duplicate is uncorrectable once written.
 *
 * The unreached list is plain report text, not a WARN finding: as a WARN it would
 * annotate ~70 files on every green run and replace the OK line.
 *
 * The restatement census printed beside the unreached list is how far
 * assertion 5 reaches, and is report text for the same reason (mantahostels#280).
 *
 * One condition SKIPs the whole run: a conflicted index. Nothing asserts against
 * it because the file set is not final until the merge commits — a resolution
 * still adds and deletes. No hook reaches this state (git refuses a commit with
 * unmerged entries before pre-commit fires) and CI checks out clean, so the
 * caller is a person running this by hand mid-resolution (mantahostels#398, docs/doc-map.md §A).
 *
 * Scope is read from git, so untracked scratch files are ignored by design.
 * git is invoked via execFileSync with an argument array (no shell), in lib/doc-map.js.
 *
 * `--root <dir>` POINTS EVERY TREE READ BUT TWO AT A MATERIALISED COPY (mantahostels#1922).
 * What moves under it: the map and its data directory, the class
 * sidecar's fallback candidate, and the tracked enumeration, which walks the
 * root because an extraction carries no `.git` to ask. `.husky/pre-commit`
 * hands it a `git checkout-index` extraction of the INDEX.
 *
 * WHAT DELIBERATELY STAYS ON THE LIVE REPO UNDER --root, and its severity:
 * `entryPresentOnDisk` (assertion 2) and `readUntrackedFiles` (assertion 4). Both
 * are severity SOFTENERS and nothing else — they turn a FAIL into a WARN for a
 * path written but not yet staged (mantahostels#1193, mantahostels#1403) — and an extraction has no
 * untracked files at all, so resolving them against the root would answer
 * "absent" for every one and turn each softened WARN back into the refusal
 * those two tickets removed. The rev-keyed reads — readMapTextAt,
 * readCommittedRevs, pairingHalfAgeMs, the always-loaded pool's `cat-file -s` and
 * the conflicted-index SKIP — ask the real repo too, and are about revisions
 * rather than about the worktree, so --root has nothing to say to them.
 *
 * NO `against` DECLARATION, unlike check-guard-registry.js and
 * check-guard-test-isolation.js: --against re-execs this file forwarding
 * POSITIONALS alone, and this checker's caller has a flag to pass —
 * --map-dirty, which asks about the real docs/doc-map.md and so cannot be
 * answered from any materialised tree. So .husky/pre-commit keeps comparing the
 * two sides through gate_direction. The residual is that its baseline extraction
 * and check.js's `tree` materialiser are now two spellings of one idea, free to
 * drift (mantahostels#1922).
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group");
const {
	DATA_FILES,
	FIGURE_ID,
	ROUTE_ID,
	assertDataIdsKnown,
	citationMatcher,
	readConflictedPaths,
	roundedSectionBWords,
	entryPresentOnDisk,
	inScope,
	isDirty,
	loadRestatements,
	parseRetiredVocabularyText,
	newOverCapEntries,
	unrecordedAdmissions,
	parseHighWaterMark,
	readHeadHighWaterMark,
	newIdsAtOrBelowMark,
	idsRemovedSinceHead,
	malformedExemptionMarkers,
	staleExemptionMarkers,
	grownExemptEntries,
	droppedExemptionMarkers,
	loadDocClasses,
	badClassEntries,
	badReaderEntries,
	pageSourceFaults,
	DOC_READERS,
	consumesFaults,
	pairScopeFaults,
	CLASSES_FILE,
	DOC_CLASSES,
	duplicateSidecarKeys,
	overCapRoles,
	renderSectionA,
	registerRowPaths,
	registerListPath,
	REGISTER_HEADER,
	ROLE_CAP_WORDS,
	overCapLedgerEntries,
	shedLedgerEntries,
	compactionVerdictFaults,
	VERDICT_MARKER,
	readCommittedRevs,
	readMapTextAt,
	LEDGER_ENTRY_CAP_BYTES,
	PROSE_CAP_WORDS,
	PAIRING_GRACE_MS,
	pairingHalfAgeMs,
	parseEntries,
	parseRoutes,
	registerPaths,
	figureHeadings,
	sectionAMatcher,
	BINARY_CLASS,
	coverageMatchers,
	readTrackedFiles,
	unresolvedSectionRefs,
	readUntrackedFiles,
} = require("./lib/doc-map");

const {
	TRIGGER_VERDICT_MARKER,
	TRIGGER_VERDICT_MIN_WORDS,
	stagedPoolDelta,
	triggerVerdictFaults,
} = require("./lib/always-loaded-pool");
const { isCollectedTestOrConftest } = require("./lib/test-kind");
const {
	coreRoot,
	inCheckout,
	resolveScriptPaths,
	scriptPath,
} = require("./lib/script-path");
const { caught } = require("./lib/caught.js");

/**
 * How advice names a generator: its npm script in the core, the plugin's copy
 * in an adopter, whose package.json has no gen: scripts (#664).
 * @param {string} name `doc-map-section-a` for `gen:doc-map-section-a`
 */
const generatorCommand = (name) =>
	inCheckout()
		? `npm run gen:${name}`
		: `node ${scriptPath(`generate-${name}.js`)}`;

/**
 * @typedef {import("./lib/check").CheckContext} Ctx
 *
 * A §C route path, or a §B restated-in path, that points at nothing.
 *
 * @typedef {{ route: string, path: string }} RoutePath
 */
/**
 * @typedef {import("./lib/doc-map").ConsumesFault} ConsumesFault
 * @typedef {{ entry: string, path: string }} RestatedPath
 */
/**
 * What every assertion below reads, settled before the first of them runs.
 *
 * @typedef {{
 *   ctx: Ctx,
 *   underRoot: (p: string) => string,
 *   mapPath: string,
 *   dataDir: string,
 *   text: string,
 *   entries: string[],
 *   classesFile: string,
 *   classesText: string,
 *   classesJson: Record<string, unknown>,
 *   sidecarKeys: string[],
 *   allTracked: string[],
 *   resolvable: string[],
 *   tracked: string[],
 *   presentUntracked: (p: string) => boolean,
 * }} Run
 * @typedef {import("./lib/doc-map").Entry} Figure
 * @typedef {Record<string, import("./lib/doc-map").RestatementEntry>} Restatements
 * @typedef {ReturnType<typeof figureHeadings>} Headings
 * @typedef {ReturnType<typeof loadDocClasses> | null} Classes
 */

/** A number standing alone, never part of an id like `B12`, `#34` or `p2-07`. */
const FIGURE = /(?<![\w#-])\d+(?:\.\d+)?(?![\w-])/g;

/*
 * Every fault this check raises has the same shape: gate on it, print it,
 * print its items, say what to do. Held as five copies, a block dropping
 * ctx.fail would gate nothing and one dropping ctx.say would print nothing
 * to a human, neither visible at the call site (mantahostels#221, the ticket that
 * collapsed them). It always FAILs: the unreached list below shares the
 * shape and stays hand-rolled precisely because it must not gate.
 *
 * `key` names the item list in the --json envelope; empty items are no
 * fault at all, so the guard lives here too. `severity` defaults to FAIL;
 * untracked-but-present entries, and a pointer fault against a dirty map,
 * pass "warn" instead (mantahostels#1193).
 *
 * The finding's identity is its tag and its items' sorted ids, so a gained
 * item reads as a new finding and the message's count never does (#1591). An
 * item's id is its printed line with every free-standing number masked — a
 * size, a count, a line number — unless `id` says otherwise.
 */
/**
 * @template T
 * @param {Ctx} ctx
 * @param {{
 *   tag: string,
 *   msg: string,
 *   key: string,
 *   items: T[],
 *   line?: (item: T) => string,
 *   id?: (item: T) => string,
 *   advice: string,
 *   severity?: "fail" | "warn",
 * }} fault
 */
function reportFault(
	ctx,
	{
		tag,
		msg,
		key,
		items,
		line = String,
		id = (item) => line(item).replace(FIGURE, "#"),
		advice,
		severity = "fail",
	},
) {
	if (items.length === 0) return;
	const ids = [...new Set(items.map(id))].sort();
	ctx[severity](tag, msg, { [key]: items }, [tag, ...ids].join("\t"));
	ctx.say(msg);
	for (const item of items) ctx.say(`  ${line(item)}`);
	ctx.say(`\n${resolveScriptPaths(advice)}`);
}

/**
 * `mm h nn m`, for a WARN's age and remaining-grace figures.
 * @param {number} ms
 */
const humanDuration = (ms) => {
	const totalMin = Math.max(0, Math.round(ms / 60_000));
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

/**
 * Splits an UNCOVERED/DEAD-ENTRY item list by the grace window (mantahostels#1785): an
 * item whose half is young WARNs, everything else — including an item
 * whose age git cannot answer — FAILs exactly as before. `dateItem` is
 * `pairingHalfAgeMs` pre-bound to the half's kind, so this stays the one
 * seam that turns an age into a verdict; it does not date anything itself.
 * The loop below never runs on an empty `items`, so `dateItem` — and so
 * git — is invoked once per faulting item and not at all on a clean run.
 * @param {string[]} items
 * @param {(item: string) => number | null} dateItem
 */
const splitByGrace = (items, dateItem) => {
	/** @type {{ item: string, ageMs: number }[]} */
	const inGrace = [];
	/** @type {string[]} */
	const outOfGrace = [];
	for (const item of items) {
		const ageMs = dateItem(item);
		if (ageMs !== null && ageMs < PAIRING_GRACE_MS)
			inGrace.push({ item, ageMs });
		else outOfGrace.push(item);
	}
	return { inGrace, outOfGrace };
};

/** @param {Ctx} ctx */
function resolveLocations(ctx) {
	/* An ABSOLUTE path is left alone: --root relocates the repo-relative
	 * defaults, and a caller naming a temp copy outright has already said
	 * which bytes it means. */
	const rootFlag = ctx.value("--root");
	const root = rootFlag ? path.resolve(rootFlag) : null;
	const underRoot = (/** @type {string} */ p) =>
		root && !path.isAbsolute(p) ? path.join(root, p) : p;

	const mapArg = ctx.args[0] || "docs/doc-map.md";
	const mapPath = underRoot(mapArg);
	const dataDir = underRoot(ctx.value("--data-dir", path.dirname(mapArg)));
	return { root, underRoot, mapPath, dataDir };
}

/** @param {Ctx} ctx */
function skipOnConflict(ctx) {
	/* The SKIP the header comment describes: the second line of defence,
	 * behind readTrackedFiles() listing a conflicted path once (mantahostels#398). */
	const conflicted = readConflictedPaths();
	if (conflicted.length > 0)
		ctx.skip(
			`the index holds ${conflicted.length} conflicted path(s), so there is ` +
				"no committed tree to count:\n" +
				conflicted.map((p) => `  ${p}`).join("\n") +
				"\nResolve them and commit, then re-run this check and paste the " +
				"header line it prints.",
		);
}

/**
 * @param {Ctx} ctx
 * @param {string} mapPath
 */
function readMap(ctx, mapPath) {
	let text;
	try {
		text = fs.readFileSync(mapPath, "utf8");
	} catch (e) {
		// The map is tracked in the repo, so an unreadable one is BROKEN.
		ctx.broken(`cannot read doc map at ${mapPath} — ${caught(e).message}`);
	}

	// The stamp doubles as a parse canary: no stamp means the file is not the map.
	const stamp = text.match(/^v\d+\.\d+ · .+$/m);
	if (!stamp) ctx.broken(`no version stamp ("vN.N · <date>") in ${mapPath}`);

	// Section A rows only — Section B quotes paths in prose and would produce
	// phantom entries. Assertions 2 and 4 still read these: a §A row naming a
	// deleted file is §A's own fault, and §A is where a reader meets it.
	const entries = registerPaths(text);

	if (entries.length === 0)
		ctx.broken(`no register entries parsed from ${mapPath} Section A`);
	return { text, stamp, entries };
}

/**
 * @param {Ctx} ctx
 * @param {{ dataDir: string, underRoot: (p: string) => string }} where
 */
function readClassSidecar(ctx, { dataDir, underRoot }) {
	/*
	 * THE REGISTER, since mantahostels#1849: coverage is asked of these keys, never of §A's
	 * rows, which assertion 17 renders from them. Absent or unparseable is
	 * BROKEN on the restatement file's reasoning (mantahostels#591) — a checker that cannot
	 * read its register must not report the tree covered.
	 *
	 * The data directory first, the tracked path second — `readMapTextAt`'s
	 * fallback, for its reason (mantahostels#1191). The second answers a caller that
	 * points `--data-dir` somewhere holding no sidecar at all. What the
	 * fallback costs, and it is said out loud where it fires: WITHOUT --root
	 * the bytes read are the working tree's, so a neighbour mid-edit can move
	 * that verdict. Under --root it is relocated with everything else, so
	 * .husky/pre-commit pays nothing for it (mantahostels#1922).
	 */
	const inDataDir = path.join(dataDir, CLASSES_FILE);
	const candidates = [
		...new Set([inDataDir, underRoot(`docs/${CLASSES_FILE}`)]),
	];
	const classesFile = candidates.find((f) => fs.existsSync(f)) || inDataDir;
	let classesText;
	try {
		classesText = fs.readFileSync(classesFile, "utf8");
	} catch (e) {
		ctx.broken(
			`cannot read the class sidecar at ${classesFile} — ${caught(e).message}. ` +
				"It is where every registered path lives, so no coverage " +
				"conclusion was drawn.",
		);
	}
	if (classesFile !== candidates[0])
		ctx.say(
			`\nno class sidecar in ${dataDir}, so coverage was read from the ` +
				`tracked ${classesFile} — the working tree's bytes, not this ` +
				"commit's.",
		);
	/** @type {Record<string, unknown>} */
	let classesJson = {};
	try {
		classesJson = JSON.parse(/** @type {string} */ (classesText));
	} catch (e) {
		ctx.broken(`${classesFile} is not JSON — ${caught(e).message}`);
	}
	if (
		!classesJson ||
		typeof classesJson !== "object" ||
		Array.isArray(classesJson)
	)
		ctx.broken(`${classesFile} does not hold an object keyed by path`);
	const sidecarKeys = Object.keys(classesJson);
	if (sidecarKeys.length === 0) ctx.broken(`${classesFile} holds no entries`);
	return {
		classesFile,
		classesText: /** @type {string} */ (classesText),
		classesJson,
		sidecarKeys,
	};
}

/**
 * @param {Ctx} ctx
 * @param {string | null} root
 */
function walkTree(ctx, root) {
	// The whole tracked tree, not just SCOPE: a Section C route may send the
	// reader to a file the register does not cover.
	let allTracked;
	try {
		allTracked = readTrackedFiles(root);
	} catch (e) {
		const { message } = caught(e);
		// git is this check's reading apparatus, not its subject: `ls-files` is how
		// it enumerates the tracked set, exactly as readFileSync above is how it
		// reads the map. SKIPping here exited 0, which turned the one CI gate on
		// doc-map coverage green whenever git broke.
		ctx.broken(
			root
				? `could not walk the materialised tree at ${root} — ${message}. No coverage conclusion drawn.`
				: `git ls-files failed — ${message}. No coverage conclusion drawn.`,
		);
	}

	/* Where a §C route, a §B restatement or a `consumes` may point: in a
	 * plugin install the core's own scripts, skills and agent docs ship at
	 * the plugin root, never in the host (#604). Existence only — coverage
	 * and every content read stay the host's, so a quoted locator on a
	 * plugin-only restatement goes unchecked here; the core checks its own. */
	let resolvable = allTracked;
	if (!inCheckout())
		try {
			resolvable = [...allTracked, ...readTrackedFiles(coreRoot())];
		} catch (e) {
			ctx.broken(`could not walk the plugin root — ${caught(e).message}`);
		}
	return { allTracked, resolvable };
}

/* Matched through citationMatcher rather than fs.existsSync because a route
 * cites a document by whatever suffix reads well — `notes.md`, not
 * `docs/notes.md` — so only the matcher the hit test uses can say which
 * uncommitted file it means. */
function untrackedMatcher() {
	/** @type {string[] | null} */
	let untrackedOnDisk = null;
	const presentUntracked = (/** @type {string} */ p) => {
		if (untrackedOnDisk === null) untrackedOnDisk = readUntrackedFiles();
		return untrackedOnDisk.some(citationMatcher(p));
	};
	return presentUntracked;
}

/**
 * Assertions 1 and 2: coverage of the tracked tree, and register rows naming
 * nothing tracked, each split by the pairing grace window.
 * @param {Run} r
 */
function checkCoverage(r) {
	const { ctx, tracked, entries, sidecarKeys, mapPath } = r;
	/* Coverage is asked of the sidecar's keys (mantahostels#1849) and the core's
	 * own CORE_CLASSES (#428); assertion 2's dead and untracked entries stay
	 * §A's rows, whose grace window dates a row's birth out of the map's own
	 * history (`pairingHalfAgeMs`). The two agree by
	 * assertion 17, which FAILs a §A row the sidecar does not key. */
	const covered = coverageMatchers(sidecarKeys);
	const matchers = entries.map((e) => ({
		entry: e,
		test: sectionAMatcher(e),
	}));

	const uncovered = tracked.filter((f) => !covered.some((test) => test(f)));
	const missing = matchers.filter((m) => !tracked.some((f) => m.test(f)));
	// A path git does not track can still be sitting on disk — normal
	// mid-ticket state, not the rename-or-delete the FAIL below describes
	// (mantahostels#1193). Only a path absent from the filesystem too is dead.
	const dead = missing
		.filter((m) => !entryPresentOnDisk(m.entry))
		.map((m) => m.entry);
	const untracked = missing
		.filter((m) => entryPresentOnDisk(m.entry))
		.map((m) => m.entry);

	const uncoveredSplit = splitByGrace(uncovered, pairingHalfAgeMs);
	const uncoveredAge = new Map(
		uncoveredSplit.inGrace.map((d) => [d.item, d.ageMs]),
	);

	reportFault(ctx, {
		tag: "UNCOVERED",
		msg: `${uncoveredSplit.outOfGrace.length} tracked file(s) in scope have no doc-map register entry:`,
		key: "files",
		items: uncoveredSplit.outOfGrace,
		advice:
			"Register each in the class sidecar — one command, one judgement, and " +
			"§A's row renders from it:\n" +
			"  node scripts/register-doc.js <path> --class <token> --section <name>\n" +
			`<token> is one of ${DOC_CLASSES.join(", ")}; <section> must spell a ` +
			"§A subsection that already exists, or add --new-section to mint one. " +
			"An unregistered document is one the update routine will never " +
			"consider.",
	});

	reportFault(ctx, {
		tag: "UNCOVERED-GRACE",
		msg:
			`${uncoveredSplit.inGrace.length} tracked file(s) in scope have no doc-map register ` +
			`entry yet, within the ${humanDuration(PAIRING_GRACE_MS)} grace window:`,
		key: "files",
		items: uncoveredSplit.inGrace.map((d) => d.item),
		id: String,
		line: (item) => {
			// `item` is always a key of `uncoveredAge`: both come from the same
			// `inGrace` list, one step apart.
			const ageMs = /** @type {number} */ (uncoveredAge.get(item));
			return (
				`${item} (introduced ${humanDuration(ageMs)} ago, ` +
				`${humanDuration(PAIRING_GRACE_MS - ageMs)} grace left — claim ` +
				`${CLASSES_FILE}#A:${item} and register it)`
			);
		},
		severity: "warn",
		advice:
			"Register it before the grace window expires, or the next sweep FAILs " +
			"it:\n" +
			"  node scripts/register-doc.js <path> --class <token> --section <name>",
	});

	const deadSplit = splitByGrace(dead, (/** @type {string} */ e) =>
		pairingHalfAgeMs(e, mapPath),
	);
	const deadAge = new Map(deadSplit.inGrace.map((d) => [d.item, d.ageMs]));

	reportFault(ctx, {
		tag: "DEAD-ENTRY",
		msg: `${deadSplit.outOfGrace.length} doc-map register entr(ies) match no tracked file:`,
		key: "entries",
		items: deadSplit.outOfGrace,
		advice: "The file was renamed or removed — update the register.",
	});

	reportFault(ctx, {
		tag: "DEAD-ENTRY-GRACE",
		msg:
			`${deadSplit.inGrace.length} doc-map register entr(ies) match no tracked file yet, ` +
			`within the ${humanDuration(PAIRING_GRACE_MS)} grace window:`,
		key: "entries",
		items: deadSplit.inGrace.map((d) => d.item),
		id: String,
		line: (item) => {
			const ageMs = /** @type {number} */ (deadAge.get(item));
			return (
				`${item} (row written ${humanDuration(ageMs)} ago, ` +
				`${humanDuration(PAIRING_GRACE_MS - ageMs)} grace left — commit the file ` +
				"the row names)"
			);
		},
		severity: "warn",
		advice:
			"Commit the file before the grace window expires, or the next sweep FAILs it.",
	});
	return { uncoveredSplit, deadSplit, untracked };
}

/**
 * Assertions 19, 31 and 32, off the sidecar's raw parse.
 * @param {Run} r
 */
function checkSidecarVocabulary(r) {
	const { ctx, classesJson } = r;
	/* Assertion 19 (mantahostels#1849). Reported here, beside coverage, because it reads
	 * the same raw parse; assertions 17 and 18 stand down below while it
	 * holds a fault. */
	const badClasses = badClassEntries(classesJson);
	reportFault(ctx, {
		tag: "UNKNOWN-CLASS",
		msg: `${badClasses.length} sidecar entr(ies) carry a class outside the documented vocabulary:`,
		key: "entries",
		items: badClasses,
		line: (e) => `${e.path} — \`${e.cls}\``,
		advice:
			`The vocabulary is exactly ${DOC_CLASSES.join(", ")} ` +
			"(docs/doc-map.md §Authority classes), and §A's rendered Update route " +
			"is derived from it, so a seventh value would render a row nothing " +
			"knows how to edit. A dual-class judgement goes in `classQualifier`, " +
			"which is free prose beside a real token — never in `class` itself. " +
			"Fix the token in the sidecar and regenerate:\n" +
			`  ${generatorCommand("doc-map-section-a")}`,
	});

	/* Assertion 31 (mantahostels#3412), off the same raw parse as 19; an unknown token
	 * stands loadDocClasses down below with it. */
	const badReaders = badReaderEntries(classesJson);
	reportFault(ctx, {
		tag: "UNKNOWN-READER",
		msg: `${badReaders.unknown.length} sidecar entr(ies) carry a reader outside the vocabulary:`,
		key: "entries",
		items: badReaders.unknown,
		line: (e) => `${e.path} — ${e.reader}`,
		advice: `The vocabulary is exactly ${DOC_READERS.join(", ")} (docs/doc-pages.md §Authority). Fix the token in the sidecar.`,
	});
	reportFault(ctx, {
		tag: "MISSING-READER",
		msg: `${badReaders.missing.length} .md or .html sidecar key(s) carry no reader:`,
		key: "paths",
		items: badReaders.missing,
		advice:
			"Every prose document states who reads it — a judgement per document, " +
			`one of ${DOC_READERS.join(", ")}. A new registration writes it:\n` +
			"  node scripts/register-doc.js <path> --class <token> --section <name> --reader <token>\n" +
			"and an already-registered key takes it as a direct sidecar edit. A " +
			"generated page takes its source's value.",
	});
	reportFault(ctx, {
		tag: "READER-ON-NON-PROSE",
		msg: `${badReaders.misplaced.length} sidecar key(s) carry a reader but are not a .md or .html document:`,
		key: "paths",
		items: badReaders.misplaced,
		advice:
			"`reader` applies to a prose document only; a wildcard key registers " +
			"many files and states no reader for any of them. Delete the field.",
	});

	/* Assertion 32 (mantahostels#3412). */
	const badPages = pageSourceFaults(classesJson);
	reportFault(ctx, {
		tag: "PAGE-SOURCE",
		msg: `${badPages.length} documentation page key(s) name a source that may not have a page:`,
		key: "pages",
		items: badPages,
		line: (p) => `${p.page} — source ${p.source} ${p.why}`,
		advice:
			"A page exists only for a registered source read by `human` or " +
			"`both` (docs/doc-pages.md §Which documents). Delete the page and its key, or correct the " +
			"source's key where its judgement is the thing that is wrong.",
	});
	return { badClasses, badReaders };
}

/**
 * @param {Ctx} ctx
 * @param {string[]} untracked
 */
function reportUntrackedEntries(ctx, untracked) {
	reportFault(ctx, {
		tag: "UNTRACKED-ENTRY",
		msg:
			`${untracked.length} doc-map register entr(ies) name a file present ` +
			"on disk but not yet tracked by git:",
		key: "entries",
		items: untracked,
		severity: "warn",
		advice:
			"Likely mid-ticket: the register edit and the file's own commit are " +
			"separate steps. Commit the file, or drop the entry if it was never " +
			"meant to land.",
	});
}

/**
 * Sorts one route's paths into dead, untracked and reached.
 * @param {Run} r
 * @param {ReturnType<typeof parseRoutes>[number]} route
 * @returns {{dead: RoutePath[], untracked: RoutePath[], reached: string[]}}
 */
function classifyRoutePaths(r, route) {
	const { resolvable, presentUntracked } = r;
	/** @type {{dead: RoutePath[], untracked: RoutePath[], reached: string[]}} */
	const sorted = { dead: [], untracked: [], reached: [] };
	for (const { path: p, destination } of route.paths) {
		const hits = resolvable.filter(citationMatcher(p));
		if (hits.length === 0)
			(presentUntracked(p) ? sorted.untracked : sorted.dead).push({
				route: route.id,
				path: p,
			});
		if (destination) sorted.reached.push(...hits);
	}
	return sorted;
}

/**
 * Assertion 4.
 * @param {Run} r
 */
function checkRoutes(r) {
	const { ctx, text, mapPath } = r;
	const routes = parseRoutes(text);

	/** @type {RoutePath[]} */
	const deadRoutes = [];
	/** @type {RoutePath[]} */
	const untrackedRoutes = [];
	/** @type {Set<string>} */
	const reached = new Set();
	for (const route of routes) {
		const sorted = classifyRoutePaths(r, route);
		deadRoutes.push(...sorted.dead);
		untrackedRoutes.push(...sorted.untracked);
		for (const f of sorted.reached) reached.add(f);
	}

	reportFault(ctx, {
		tag: "DEAD-ROUTE",
		msg: `${deadRoutes.length} Section C route path(s) in ${mapPath} point at no tracked file:`,
		key: "routes",
		items: deadRoutes,
		line: (d) => `${d.route} → ${d.path}`,
		advice: "The file was renamed or removed — send the route somewhere real.",
	});

	reportFault(ctx, {
		tag: "UNTRACKED-ROUTE",
		msg:
			`${untrackedRoutes.length} Section C route path(s) in ${mapPath} ` +
			"name a file present on disk but not yet tracked by git:",
		key: "routes",
		items: untrackedRoutes,
		line: (d) => `${d.route} → ${d.path}`,
		severity: "warn",
		advice: "Commit the file, or drop the route until it lands.",
	});
	return { routes, reached, deadRoutes, untrackedRoutes };
}

/**
 * The `### C<n>` ids in reading order, fenced blocks skipped.
 * @param {string} text
 */
function collectRouteIds(text) {
	/** @type {string[]} */
	const routeIds = [];
	let fencedRoute = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fencedRoute = !fencedRoute;
			continue;
		}
		if (fencedRoute) continue;
		const heading = line.match(ROUTE_ID);
		if (heading) routeIds.push(requiredGroup(heading, 1, ROUTE_ID));
	}
	return routeIds;
}

/* Assertion 7 (mantahostels#1229). The one thing that notices a §C route being
 * deleted: coverage never gates (mantahostels#22) and the routes self-count is
 * re-derived from the map, so the generator writes the lower figure as
 * readily as the higher.
 *
 * The run is measured against the highest id, not the number of headings,
 * so a legitimate route above a gap is never itself accused. Ids are
 * compared as a set — §C's headings sit in reading order, not numeric
 * order.
 *
 * Accepted residual: everything above the highest surviving id is
 * invisible — deleting the top route, the top k, or all of §C passes.
 * Catching that needs a retired-route sidecar holding a high-water mark,
 * priced and declined at mantahostels#1229.
 *
 * Fenced blocks are skipped as assertion 6 skips them: this document
 * quotes its own formats.
 */
/** @param {Run} r */
function checkRouteIds(r) {
	const { ctx, text, mapPath } = r;
	const routeIds = collectRouteIds(text);

	const heldRouteIds = new Set(routeIds);
	const highestRoute = Math.max(
		0,
		...routeIds.map((id) => Number(id.slice(1))),
	);
	/** @type {{ id: string, why: string }[]} */
	const routeIdFaults = [];
	for (let n = 1; n <= highestRoute; n++)
		if (!heldRouteIds.has(`C${n}`))
			routeIdFaults.push({ id: `C${n}`, why: "no route carries this id" });
	for (const id of heldRouteIds)
		if (routeIds.filter((other) => other === id).length > 1)
			routeIdFaults.push({ id, why: "heads more than one route" });
	// C0 and a leading zero both survive the run check — Number("C01") is 1 —
	// yet neither is citable as the `§C<n>` every sidecar spells.
	for (const id of heldRouteIds)
		if (/^C0/.test(id))
			routeIdFaults.push({
				id,
				why: "ids run from C1 and carry no leading zero",
			});

	reportFault(ctx, {
		tag: "ROUTE-ID-GAP",
		msg:
			`${mapPath}'s Section C route ids must be the dense run ` +
			`C1-C${highestRoute}, its highest id. Out of place:`,
		key: "ids",
		items: routeIdFaults,
		line: (f) => `${f.id} — ${f.why}`,
		advice:
			"Route ids are permanent, and documents outside §C cite them by " +
			"name, so closing a gap by renumbering breaks those citers (mantahostels#1229). " +
			"A route whose document moved is repointed, never deleted — a dead " +
			"path in a route FAILs above (mantahostels#212). A duplicate or a malformed id " +
			"takes the next free number.",
	});
	return routeIdFaults;
}

/**
 * @param {Ctx} ctx
 * @param {string} dataFile
 * @param {Figure[]} figures
 */
function readRestatements(ctx, dataFile, figures) {
	let restatementData = null;
	try {
		restatementData = loadRestatements(dataFile, {
			allowEmpty: figures.length === 0,
		});
	} catch (e) {
		const { code, message } = caught(e);
		ctx.broken(
			code === "ENOENT"
				? `restatement data file ${dataFile} is missing — §B's restatement ` +
						"paths live there, so there is nothing to check against."
				: `restatement data file unreadable — ${message}`,
		);
	}
	return restatementData;
}

/**
 * Assertion 5.
 * @param {Run} r
 */
function checkRestatements(r) {
	const { ctx, text, mapPath, dataDir, resolvable } = r;
	/* Restatement paths come from the data file and from nowhere else (mantahostels#591):
	 * a missing one is BROKEN, never a silent scan of zero paths, which reads
	 * identically to a registry whose every path is live. */
	const dataFile = path.join(dataDir, DATA_FILES.restatements);
	const figures = parseEntries(text, FIGURE_ID);
	const restatementData = readRestatements(ctx, dataFile, figures);

	// Deliberately never added to `reached`: a figure's blast radius is not
	// question-route coverage, and counting it would silence the unreached list
	// for files no route names.
	/** @type {RestatedPath[]} */
	const deadRestatements = [];
	assertDataIdsKnown(ctx, restatementData, figures, dataFile);
	let restatementPaths = 0;
	let figuresRestated = 0;
	for (const [id, entry] of Object.entries(restatementData)) {
		restatementPaths += entry.paths.length;
		figuresRestated++;
		for (const item of entry.paths)
			if (!resolvable.some(citationMatcher(item.path)))
				deadRestatements.push({ entry: id, path: item.path });
	}

	reportFault(ctx, {
		tag: "DEAD-RESTATEMENT",
		msg: `${deadRestatements.length} Section B restated-in path(s) in ${mapPath} point at no tracked file:`,
		key: "restatements",
		items: deadRestatements,
		line: (d) => `${d.entry} → ${d.path}`,
		advice:
			"The file was renamed or removed — a restatement dropped from the " +
			"list is a stale copy the propagation pass will never reach.",
	});
	return {
		restatementData,
		figures,
		restatementPaths,
		figuresRestated,
		deadRestatements,
	};
}

/**
 * The fields of one restatement entry a line locator may sit in, each with
 * where the report says it sat.
 * @param {import("./lib/doc-map").RestatementEntry} entry
 */
function locatorFields(entry) {
	/** @type {[string, string | undefined][]} */
	const fields = [["note", entry.note]];
	for (const item of entry.paths)
		for (const field of /** @type {const} */ (["locator", "gloss"]))
			fields.push([`${field} on \`${item.path}\``, item[field]]);
	return fields;
}

/**
 * @param {Run} r
 * @param {{ restatementData: Restatements, figures: Figure[] }} sources
 */
function checkLineLocators(r, { restatementData, figures }) {
	const { ctx } = r;
	/* Assertions 27 and 28 (mantahostels#3151). */
	// The lookarounds keep `CL4` and `L2-cache` out: a line reference is
	// never letter-prefixed and never hyphenated. The other two limbs are
	// the `<file>:<n>` citation (mantahostels#3160): a file with one of the extensions
	// this repo cites, or any slash-bearing path (`.husky/pre-commit:12`),
	// then a colon and a line or `<n>-<m>` range. A clock time, a `3:1`
	// ratio and a bare `host.tld:port` never match; a `Node.js:20` version
	// pin would, and none is written in §B.
	const citedExt =
		"md|py|sh|ts|tsx|js|mjs|cjs|json|jsonl|html|yml|yaml|css|csv|txt";
	const lineToken = new RegExp(
		"(?<![A-Za-z\\d])L\\d+(?![\\w-])" +
			`|(?<![\\w/.-])(?:[\\w.-]*/)*[\\w.-]*\\.(?:${citedExt}):\\d+(?:-\\d+)?(?![\\w-])` +
			"|(?<![\\w/.-])[\\w.-]+(?:/[\\w.-]+)+:\\d+(?:-\\d+)?(?![\\w-])",
	);
	/** @type {{ entry: string, where: string, token: string }[]} */
	const lineLocators = [];
	for (const [id, entry] of Object.entries(restatementData)) {
		for (const [where, value] of locatorFields(entry)) {
			const m = typeof value === "string" ? lineToken.exec(value) : null;
			if (m) lineLocators.push({ entry: id, where, token: m[0] });
		}
	}
	for (const fig of figures) {
		const m = lineToken.exec(fig.lines.join("\n"));
		if (m)
			lineLocators.push({ entry: fig.id, where: "entry prose", token: m[0] });
	}
	reportFault(ctx, {
		tag: "LINE-LOCATOR",
		msg: `${lineLocators.length} line-number locator(s) in §B or ${DATA_FILES.restatements}:`,
		key: "lineLocators",
		items: lineLocators,
		line: (d) => `${d.entry} — ${d.token} in ${d.where}`,
		advice:
			"A line number drifts on every edit above it and nothing re-derives " +
			"it (mantahostels#3151). Pin the sentence with its `§` section, a verbatim " +
			'"quoted phrase" the file holds, or both — §B\'s preamble has the form.',
	});
	return lineLocators;
}

/**
 * Each quoted phrase in one restatement path's locator that its file no
 * longer holds.
 * @param {Run} r
 * @param {{ id: string, item: import("./lib/doc-map").RestatementPath }} at
 * @param {Map<string, string>} anchorFileText accumulator: each file read is cached here by path
 * @returns {{ entry: string, path: string, phrase: string }[]}
 */
function collectDeadAnchors(r, { id, item }, anchorFileText) {
	const { allTracked, underRoot } = r;
	if (typeof item.locator !== "string" || !item.locator.includes('"'))
		return [];
	const [file, other] = allTracked.filter(citationMatcher(item.path));
	if (file === undefined || other !== undefined) return [];
	if (!anchorFileText.has(file))
		anchorFileText.set(file, fs.readFileSync(underRoot(file), "utf8"));
	const body = /** @type {string} */ (anchorFileText.get(file));
	const quoted = /"([^"]+)"/g;
	/** @type {{ entry: string, path: string, phrase: string }[]} */
	const dead = [];
	for (const m of item.locator.matchAll(quoted)) {
		const phrase = requiredGroup(m, 1, quoted);
		if (!body.includes(phrase))
			dead.push({ entry: id, path: item.path, phrase });
	}
	return dead;
}

/**
 * Assertion 28.
 * @param {Run} r
 * @param {Restatements} restatementData
 */
function checkDeadAnchors(r, restatementData) {
	const { ctx } = r;
	/** @type {{ entry: string, path: string, phrase: string }[]} */
	const deadAnchors = [];
	/** @type {Map<string, string>} */
	const anchorFileText = new Map();
	for (const [id, entry] of Object.entries(restatementData))
		for (const item of entry.paths)
			deadAnchors.push(...collectDeadAnchors(r, { id, item }, anchorFileText));
	reportFault(ctx, {
		tag: "DEAD-ANCHOR",
		msg: `${deadAnchors.length} quoted locator phrase(s) in ${DATA_FILES.restatements} that the file no longer holds:`,
		key: "deadAnchors",
		items: deadAnchors,
		line: (d) => `${d.entry} → ${d.path}: "${d.phrase}"`,
		advice:
			"Re-quote the phrase from the sentence as it now reads. Where the " +
			"sentence is gone, the copy has moved or been cut — that is the " +
			"propagation pass's visit, not a locator edit.",
	});
	return deadAnchors;
}

/** @param {Run} r */
function checkSectionRefs(r) {
	const { ctx, text, classesJson, allTracked, underRoot } = r;
	/* Assertion 33 (#805). Off the raw sidecar, so a bad class token
	 * (assertion 19) still leaves the exemptions readable. */
	const refExempt = Object.entries(classesJson)
		.filter(
			([, v]) => /** @type {{ class?: unknown }} */ (v)?.class === BINARY_CLASS,
		)
		.map(([k]) => sectionAMatcher(k));
	/** @type {{ file: string, text: string }[]} */
	const refFiles = [];
	for (const file of allTracked) {
		if (isCollectedTestOrConftest(file) || refExempt.some((t) => t(file)))
			continue;
		let body;
		try {
			body = fs.readFileSync(underRoot(file), "utf8");
		} catch {
			// Tracked but absent from the tree holds no reference to check.
			continue;
		}
		if (body.includes("doc-map.md")) refFiles.push({ file, text: body });
	}
	const deadRefs = unresolvedSectionRefs(text, refFiles);
	reportFault(ctx, {
		tag: "DEAD-SECTION-REF",
		msg: `${deadRefs.length} reference(s) to a docs/doc-map.md section that does not exist:`,
		key: "sectionRefs",
		items: deadRefs,
		line: (d) => `${d.file}: ${d.ref}`,
		advice:
			"Point the reference at a heading the map carries — §A, §B and §C " +
			"name their Sections, `§<n>` the one `### <n>.` subsection carrying " +
			"that number, `§X §<n>` the `### <n>.` under §X — or give the map " +
			"the section it names. A `§X preamble` needs prose under §X's " +
			"heading before its first sub-heading.",
	});
	return deadRefs;
}

/**
 * The restatement census and the unreached list: report text, never a fault.
 * @param {Run} r
 * @param {{
 *   restatementPaths: number,
 *   figuresRestated: number,
 *   figures: Figure[],
 *   reached: Set<string>,
 * }} census
 */
function reportCensus(
	r,
	{ restatementPaths, figuresRestated, figures, reached },
) {
	const { ctx, tracked } = r;
	/* Report-only for the same reason as the unreached list; printed rather
	 * than hand-counted because the prose quoting it went stale unnoticed
	 * (mantahostels#280). Unguarded: the data file is mandatory and holds at least one
	 * entry, and every key it holds must name a `### B<n>` heading, so a map
	 * with no §B entries is BROKEN above rather than a run reaching here
	 * with an empty denominator (mantahostels#591). */
	ctx.say(
		`\n${restatementPaths} restatement path(s) across ` +
			`${figuresRestated} of ${figures.length} §B entries ` +
			"(existence checked, completeness not — not a failure).",
	);

	const unreached = tracked.filter((f) => !reached.has(f));
	if (unreached.length > 0) {
		ctx.say(
			`\nReached by no Section C route (${unreached.length} of ${tracked.length} in-scope files, not a failure):`,
		);
		for (const f of unreached) ctx.say(`  ${f}`);
	}
	return unreached;
}

/** @param {Run} r */
function checkDuplicateIds(r) {
	const { ctx, text } = r;
	/* Assertion 6 (mantahostels#970). parseEntries keys by id, so a duplicate would be
	 * invisible to every reader that walks its output — the count is taken from
	 * the raw headings for exactly that reason. */
	/** @type {Map<string, string>} */
	const seen = new Map();
	/** @type {string[]} */
	const duplicates = [];
	// figureHeadings skips fenced blocks, as lib/doc-map-regions.js skips them
	// for the allocator: this document quotes its own formats, and an example
	// heading inside a fence would be failed here while the allocator hands
	// its id out as free.
	const headings = figureHeadings(text.split("\n"));
	for (const { id, line } of headings) {
		if (seen.has(id)) duplicates.push(`${id} — first as: ${seen.get(id)}`);
		else seen.set(id, line);
	}

	reportFault(ctx, {
		tag: "DUPLICATE-ENTRY-ID",
		msg: `${duplicates.length} Section B entry id(s) appear more than once:`,
		key: "ids",
		items: duplicates,
		advice:
			"Ids are permanent and are never reused or renumbered (mantahostels#892), " +
			"and doc-map-restatements.json, -retired-vocabulary.json and " +
			"-superseded.json all key off them — so a duplicate hands one entry's " +
			"rows to another. Give the newer entry the next free id:\n" +
			"  node scripts/session-arbiter.js alloc-entry docs/doc-map.md\n" +
			"which allocates it atomically and claims the append slot with it.",
	});
	return { headings, seen, duplicates };
}

/** @param {Run} r */
function checkDuplicateKeys(r) {
	const { ctx, classesText, classesFile } = r;
	/* Assertion 8 (mantahostels#1402; moved off §A's rows onto the sidecar's own keys at
	 * mantahostels#1849). §B's equivalent is assertion 6 above, and reads the raw text for
	 * the same reason this does. */
	const rowDuplicates = duplicateSidecarKeys(classesText);
	reportFault(ctx, {
		tag: "DUPLICATE-REGISTER-KEY",
		msg: `${rowDuplicates.length} key(s) appear twice in ${classesFile}:`,
		key: "paths",
		items: rowDuplicates,
		advice:
			"A key is its arbiter region id (`A:<path>`, lib/doc-map-regions.js), " +
			"so a repeat hands two entries one lock and puts their two writers " +
			"back in contention — and JSON.parse keeps the last of them, so the " +
			"class the earlier one records is silently gone. One key per " +
			"document: delete the duplicate, keeping the entry that records the " +
			"class you meant.",
	});
	return rowDuplicates;
}

/** @param {Run} r */
function checkCanonicalSidecar(r) {
	const { ctx, classesText, classesJson, classesFile } = r;
	/* Assertion 30 (mantahostels#3353): re-derive the sidecar's canonical bytes from
	 * its own parsed content, per register-doc.js's header, and diff. */
	const canonicalClasses = `${JSON.stringify(
		Object.fromEntries(
			Object.keys(classesJson)
				.sort()
				.map((k) => [k, classesJson[k]]),
		),
		null,
		"\t",
	)}\n`;
	const classesDrift = [];
	if (classesText !== canonicalClasses) {
		// Drop the trailing "" both splits produce from the files' own
		// trailing newline — otherwise an identical trailing blank still
		// counts as one differing line on top of the real drift.
		const have = classesText.replace(/\n$/, "").split("\n");
		const want = canonicalClasses.replace(/\n$/, "").split("\n");
		let differing = 0;
		for (let i = 0; i < Math.max(have.length, want.length); i++)
			if (have[i] !== want[i]) differing++;
		classesDrift.push(
			`${differing} of ${want.length} line(s) differ from the canonical form`,
		);
	}
	reportFault(ctx, {
		tag: "SIDECAR-NOT-CANONICAL",
		msg: `${classesFile} is not register-doc.js's canonical serialisation:`,
		key: "lines",
		items: classesDrift,
		advice:
			"A \\u00a7 or \\u2014 in the diff is the signature of a " +
			"writer defaulting to ASCII-safe JSON (Python's json.dump, " +
			"ensure_ascii=True by default) rather than register-doc.js's " +
			"unescaped JSON.stringify. Re-run the edit through:\n" +
			"  node scripts/register-doc.js <path> --class <token> --section <name>\n" +
			"or hand-fix the file so it round-trips: parse it, then write back " +
			"`JSON.stringify(Object.fromEntries(Object.keys(parsed).sort()." +
			'map(k => [k, parsed[k]])), null, "\\t") + "\\n"`.',
	});
	return classesDrift;
}

/**
 * @param {Ctx} ctx
 * @param {Headings} headings
 */
function checkStrays(ctx, headings) {
	/** @type {string[]} */
	const strays = headings
		.filter((h) => h.stray)
		.map((h) => `${h.id} — line ${h.index + 1}, outside Section B`);

	reportFault(ctx, {
		tag: "STRAY-ENTRY",
		msg: `${strays.length} Section B entry heading(s) sit outside Section B:`,
		key: "ids",
		items: strays,
		advice:
			"Section B is read as the line range from `## Section B` to the next " +
			"`## ` heading, so an entry appended below it is missing from every " +
			"figure taken over that range — §B's word count here, and the " +
			"80,000-word budget report — which then read low rather than wrong. " +
			"The entry parsers are whole-file, so the drain queue and the " +
			"duplicate-id check above still see it. Move the entry into the " +
			"range, in id order, block intact: it is a relocation, never a " +
			"rewrite, and the mover is\n" +
			"  node scripts/move-stray-doc-map-entries.js docs/doc-map.md",
	});
	return strays;
}

/**
 * @param {Ctx} ctx
 * @param {Figure[]} figures
 */
function checkSettledAt(ctx, figures) {
	/* Assertion 10 (mantahostels#1458). parseEntries is whole-file and does not skip
	 * fenced blocks, so a quoted example entry owes the bullet too — the
	 * map's own fenced examples carry it. */
	/** @type {string[]} */
	const settledMissing = figures
		.filter((f) => !/^\s*-\s*\*\*Settled at/m.test(f.lines.join("\n")))
		.map((f) => f.id);

	reportFault(ctx, {
		tag: "SETTLED-AT-MISSING",
		msg: `${settledMissing.length} Section B entr(ies) carry no \`Settled at\` bullet:`,
		key: "ids",
		items: settledMissing,
		advice:
			"Every entry names the ticket that decided its figure — that ticket is " +
			"where each derivation cut from the entry was sent, so an entry " +
			"without one strands its own working. Two spellings, and only two:\n" +
			"  - **Settled at #<n>**, <date>.\n" +
			"  - **Settled at:** none — <why nothing decided it>.\n" +
			"Never merely absent (mantahostels#1219).",
	});
	return settledMissing;
}

/* Assertion 11 (mantahostels#1474). The three templates §B's preamble states, and the
 * one optional suffix: the bare known-incomplete marker, kept in the
 * bullet so `check-doc-map-markers.js` still ages the entry (mantahostels#1471). */
const pointerPaths =
	/^- \*\*Restated in:\*\* (\d+) paths?, in `docs\/doc-map-restatements\.json`\.( ⚠ \*\*Restated-in is known incomplete\*\*\.)?$/;
const pointerNone =
	/^- \*\*Restated in:\*\* none — .+?\.( ⚠ \*\*Restated-in is known incomplete\*\*\.)?$/;
const pointerSupersedes =
	/^- \*\*Supersedes( \([^)]*\))?:\*\* see `docs\/doc-map-superseded\.json`\.$/;

/**
 * @param {Ctx} ctx
 * @param {string} dataDir
 */
function readSupersededData(ctx, dataDir) {
	/* Key presence only, read straight off the JSON rather than through
	 * loadSupersededNeedles: this assertion asks which entries the file keys,
	 * and the file's *shape* is check-superseded-values.js's to police — two
	 * checkers BROKENing on one file's schema is one owner too many.
	 *
	 * An ABSENT file is not an empty one: read as empty, every conforming
	 * `Supersedes` pointer would fail as naming a key that is not there. So
	 * the two `Supersedes` limbs are skipped instead, and the run says they
	 * were. A file that will not parse is real corruption and is BROKEN. */
	const supersededFile = path.join(dataDir, DATA_FILES.supersededNeedles);
	/** @type {Record<string, unknown> | null} */
	let supersededData = null;
	try {
		supersededData = JSON.parse(fs.readFileSync(supersededFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT")
			ctx.broken(`superseded data file unreadable — ${message}`);
	}
	return { supersededFile, supersededData };
}

/**
 * @param {Ctx} ctx
 * @param {string} dataDir
 */
function readVocabData(ctx, dataDir) {
	/* A §B entry's `Retired vocabulary` bullet states its phrase count in
	 * prose; nothing compared it to the sidecar (mantahostels#2293). Read raw, the
	 * superseded sidecar's reasoning just above: check-retired-vocabulary.js
	 * owns this file's schema, and loadRetiredVocabulary's "holds no
	 * entries" guard is right for that owner but wrong here — no vocabulary
	 * retired yet is a legitimate empty file, not corruption (mantahostels#2324).
	 * Only a file that will not parse is BROKEN here.
	 *
	 * Residual (mantahostels#2324): check-retired-vocabulary.js runs only on the
	 * scheduled sweeps — unlike check-superseded-values.js, which also runs
	 * in .husky/pre-commit. A malformed vocab sidecar this guard used to
	 * catch at commit time is now caught only on the next sweep. */
	const vocabFile = path.join(dataDir, DATA_FILES.retiredVocabulary);
	/** @type {Record<string, { phrases?: unknown[] }> | null} */
	let vocabData = null;
	try {
		vocabData = JSON.parse(fs.readFileSync(vocabFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT")
			ctx.broken(`retired-vocabulary data file unreadable — ${message}`);
	}
	return { vocabFile, vocabData };
}

/**
 * @typedef {{
 *   f: Figure,
 *   restatementData: Restatements,
 *   supersededData: Record<string, unknown> | null,
 *   vocabData: Record<string, { phrases?: unknown[] }> | null,
 * }} PointerScope
 */

/**
 * @param {PointerScope} s
 * @param {string} line
 * @returns {string[]} the line's pointer faults
 */
function restatedInFaults({ f, restatementData }, line) {
	const m = line.match(pointerPaths);
	if (m) {
		const key = restatementData[f.id];
		if (!key)
			return [
				`${f.id} — points at ${DATA_FILES.restatements}, which holds no key for it`,
			];
		if (Number(m[1]) !== key.paths.length)
			return [
				`${f.id} — pointer says ${m[1]} path(s), the sidecar holds ${key.paths.length}`,
			];
		return [];
	}
	if (pointerNone.test(line)) {
		const held = restatementData[f.id];
		return held
			? [
					`${f.id} — says \`none\` while ${DATA_FILES.restatements} holds ${held.paths.length} path(s)`,
				]
			: [];
	}
	return [
		`${f.id} — \`Restated in\` matches no template: ${line.trim().slice(0, 80)}`,
	];
}

/**
 * @param {PointerScope} s
 * @param {string} line
 * @returns {string[]} the line's pointer faults
 */
function supersedesFaults({ f, supersededData }, line) {
	if (!pointerSupersedes.test(line))
		return [
			`${f.id} — \`Supersedes\` matches no template: ${line.trim().slice(0, 80)}`,
		];
	if (supersededData && !supersededData[f.id])
		return [
			`${f.id} — \`Supersedes\` points at ${DATA_FILES.supersededNeedles}, which holds no key for it`,
		];
	return [];
}

/* Same question, asked once, of the Retired vocabulary bullet's own
 * prose count (mantahostels#2293) — free-text, unlike Restated in's three fixed
 * templates, so only the leading `<n> phrase(s)` is read rather than
 * the whole line matched against a template.
 *
 * Unlike an unkeyed `Restated in` pointer (FAILs), an entry the
 * sidecar does not key is silent here — `vocabPhrases` stays
 * undefined and neither branch below fires — because an uncovered
 * entry is check-retired-vocabulary.js's fault to raise, not this
 * one's. Residual: a §B entry whose retired-vocabulary key was
 * dropped from the sidecar keeps a stale count here unchecked. */
/**
 * @param {PointerScope} s
 * @returns {string[]} the entry's phrase-count fault, if any
 */
function vocabCountFaults({ f, vocabData }) {
	const vocabText = parseRetiredVocabularyText(f.lines);
	if (vocabText === null) return [];
	const m = vocabText.match(/(\d+)\s+phrases?\b/i);
	const vocabPhrases = vocabData?.[f.id]?.phrases;
	if (!m)
		return [`${f.id} — \`Retired vocabulary\` bullet states no phrase count`];
	if (Array.isArray(vocabPhrases) && Number(m[1]) !== vocabPhrases.length)
		return [
			`${f.id} — \`Retired vocabulary\` bullet says ${m[1]} phrase(s), ` +
				`${DATA_FILES.retiredVocabulary} holds ${vocabPhrases.length}`,
		];
	return [];
}

/**
 * @param {PointerScope} s
 * @returns {string[]} the entry's pointer faults
 */
function figurePointerFaults(s) {
	const { f, restatementData, supersededData } = s;
	/** @type {string[]} */
	const faults = [];
	const body = f.lines;
	let sawRestated = false;
	let sawSupersedes = false;
	for (const line of body) {
		if (/^\s*-\s*\*\*Restated in/.test(line)) {
			sawRestated = true;
			faults.push(...restatedInFaults(s, line));
		}
		if (/^\s*-\s*\*\*Supersedes/.test(line)) {
			sawSupersedes = true;
			faults.push(...supersedesFaults(s, line));
		}
	}

	faults.push(...vocabCountFaults(s));

	if (!sawRestated && restatementData[f.id])
		faults.push(
			`${f.id} — ${DATA_FILES.restatements} holds a key for it, and the entry carries no \`Restated in\` bullet`,
		);
	if (!sawSupersedes && supersededData?.[f.id])
		faults.push(
			`${f.id} — ${DATA_FILES.supersededNeedles} holds a key for it, and the entry carries no \`Supersedes\` bullet`,
		);
	return faults;
}

/**
 * Assertion 11's per-entry half: every §B entry's pointer bullets against
 * the sidecars they name.
 * @param {Run} r
 * @param {{ restatementData: Restatements, figures: Figure[] }} sources
 */
function checkPointerShapes(r, { restatementData, figures }) {
	const { ctx, dataDir } = r;
	const { supersededFile, supersededData } = readSupersededData(ctx, dataDir);
	const { vocabFile, vocabData } = readVocabData(ctx, dataDir);

	const pointerFaults = figures.flatMap((f) =>
		figurePointerFaults({ f, restatementData, supersededData, vocabData }),
	);
	return {
		pointerFaults,
		supersededFile,
		supersededData,
		vocabFile,
		vocabData,
	};
}

/**
 * @param {Ctx} ctx
 * @param {string} mapPath
 */
function isMapDirty(ctx, mapPath) {
	// A dirty map is a live session mid-edit: its sidecars are written
	// alongside it as the edit's last step, so a pointer fault
	// here is that step not having run yet — not a broken commit (mantahostels#1193).
	// Against a clean map the same fault is still FAIL: the committed
	// sidecar genuinely disagrees with the committed map it describes.
	//
	// --map-dirty is how .husky/pre-commit says so: since mantahostels#1191 it feeds this
	// script a `$(mktemp -d)` copy of docs/doc-map.md, a path with no git
	// identity of its own, so isDirty(mapPath) below would always read
	// "clean" there regardless of the real file — the one route the FAIL
	// this softens was ever hit on. Absent the flag, mapPath is presumed to
	// be the real tracked path (true for every other caller, this script's
	// own tests included).
	return ctx.has("--map-dirty") || isDirty(mapPath);
}

/**
 * Assertion 11's whole-sidecar half, and what went unreconciled.
 * @param {Run} r
 * @param {Figure[]} figures
 * @param {ReturnType<typeof checkPointerShapes>} pointers
 * @returns {string[]} a pointer fault per superseded-needles key no entry holds
 */
function reconcilePointerSidecars(
	r,
	figures,
	{ supersededFile, supersededData, vocabFile, vocabData },
) {
	const { ctx, mapPath } = r;
	/** @type {string[]} */
	const pointerFaults = [];
	/* assertDataIdsKnown above covers the restatements sidecar; nothing else
	 * here reads this one. */
	if (supersededData) {
		const held = new Set(figures.map((f) => f.id));
		for (const id of Object.keys(supersededData))
			if (!held.has(id))
				pointerFaults.push(
					`${id} — ${DATA_FILES.supersededNeedles} keys it, and ${mapPath} holds no such entry`,
				);
	}

	if (!supersededData)
		ctx.say(
			`\n${supersededFile} is absent, so a \`Supersedes\` pointer's key ` +
				"was not reconciled — shape alone was checked.",
		);

	if (vocabData === null)
		ctx.say(
			`\n${vocabFile} is absent, so a \`Retired vocabulary\` bullet's ` +
				"phrase count was not reconciled — the bullet's own template was " +
				"still checked.",
		);
	return pointerFaults;
}

/**
 * The high-water mark the data file holds; BROKEN where the file is missing or
 * does not hold one, as there is then nothing to check a new id against.
 * @param {Ctx} ctx
 * @param {string} markFile
 * @returns {number}
 */
function readHighWaterMark(ctx, markFile) {
	let raw;
	try {
		raw = fs.readFileSync(markFile, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		ctx.broken(
			code === "ENOENT"
				? `high-water mark file ${markFile} is missing. Write it as ` +
						'{ "highWaterMark": <n> }, n being the number of the highest ' +
						"§B id ever removed from the map (0 where none has been)."
				: `high-water mark file unreadable — ${message}`,
		);
	}
	const mark = parseHighWaterMark(raw);
	if (mark === null)
		ctx.broken(
			`high-water mark file ${markFile} holds no \`highWaterMark\` that is ` +
				"a non-negative integer.",
		);
	return mark;
}

/**
 * Assertions 12 and 13 (#2339).
 * @param {Run} r
 */
function checkHighWaterMark(r) {
	const { ctx, text, mapPath, dataDir } = r;
	const markFile = path.join(dataDir, DATA_FILES.highWater);
	const mark = readHighWaterMark(ctx, markFile);

	const reusedOrNull = newIdsAtOrBelowMark(text, mapPath, mark);
	const removedOrNull = idsRemovedSinceHead(text, mapPath);
	if (reusedOrNull === null || removedOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so whether ` +
				"this commit adds or removes a §B entry could not be read — the " +
				"high-water mark was not checked against it.",
		);
	reportFault(ctx, {
		tag: "REUSED-ENTRY-ID",
		msg: `${(reusedOrNull || []).length} §B id(s) new since HEAD sit at or below the high-water mark, B${mark}:`,
		key: "ids",
		items: reusedOrNull || [],
		advice:
			"Ids are permanent (mantahostels#892): an id at or below the mark may " +
			"have been held by a removed entry, and a reference to that entry " +
			"would resolve to this one. Give the entry the next free id instead:\n" +
			`  node scripts/session-arbiter.js alloc-entry ${mapPath}`,
	});

	const headMark = readHeadHighWaterMark(markFile);
	const removedAbove = (removedOrNull || []).filter(
		(id) => Number(id.slice(1)) > mark,
	);
	/** @type {string[]} */
	const markFaults = removedAbove.map(
		(id) => `${id} leaves the map, above the mark B${mark}`,
	);
	if (headMark !== null && mark < headMark)
		markFaults.push(`the mark falls from HEAD's B${headMark} to B${mark}`);
	const wanted = Math.max(
		mark,
		headMark ?? 0,
		...removedAbove.map((id) => Number(id.slice(1))),
	);
	reportFault(ctx, {
		tag: "HIGH-WATER-MARK",
		msg: `${DATA_FILES.highWater} does not hold the highest §B id ever removed:`,
		key: "faults",
		items: markFaults,
		advice:
			`Set \`highWaterMark\` in ${markFile} to ${wanted}, in the commit ` +
			"that removes the entry. The mark never falls: lowered, it lets a " +
			"later commit reuse an id a removed entry held.",
	});
}

const buildConsumesLine = (/** @type {ConsumesFault} */ d) =>
	`${d.doc} → ${d.ref} — ${d.why}`;

/**
 * @param {Run} r
 * @param {{
 *   headings: Headings,
 *   mapDirty: boolean,
 * }} state
 */
function checkConsumes(r, { headings, mapDirty }) {
	const {
		ctx,
		classesJson,
		classesFile,
		mapPath,
		resolvable,
		presentUntracked,
	} = r;
	/* Assertion 25 (mantahostels#2419). */
	const consumes = consumesFaults(classesJson, {
		tracked: resolvable,
		presentUntracked,
		liveFigures: new Set(headings.map((h) => h.id)),
	});

	/* A MALFORMED reference is not softened, and is split out to say so.
	 * `--map-dirty` excuses a pointer whose target moved in a commit the
	 * sidecar has not caught up with; softening a reference that is not a
	 * reference would take a sidecar `loadDocClasses` refuses to load green
	 * through pre-commit. */
	const malformedConsumes = consumes.dead.filter((d) => d.shape);
	const unresolvedConsumes = consumes.dead.filter((d) => !d.shape);

	reportFault(ctx, {
		tag: "MALFORMED-CONSUMES",
		msg:
			`${malformedConsumes.length} \`consumes\` reference(s) in ${classesFile} ` +
			"are not typed references at all:",
		key: "references",
		items: malformedConsumes,
		line: buildConsumesLine,
		advice:
			"A reference is `{ kind, ref, gloss? }`, `kind` one of path, glob, " +
			"figure, issue, external, note. The sidecar will not load until " +
			"every element spells that.",
	});

	reportFault(ctx, {
		tag: "DEAD-CONSUMES",
		msg:
			`${unresolvedConsumes.length} typed \`consumes\` reference(s) in ${classesFile} ` +
			"resolve to nothing:",
		key: "references",
		items: unresolvedConsumes,
		line: buildConsumesLine,
		severity: mapDirty ? "warn" : "fail",
		advice: mapDirty
			? `${mapPath} has uncommitted edits, so the sidecar may not have been ` +
				"written yet. Land the edit, then re-run."
			: "The target was renamed or removed — send the reference " +
				"somewhere real, or retype it as `note` where it was never a " +
				"pointer. §A renders from this file, so regenerate after fixing:\n" +
				`  ${generatorCommand("doc-map-section-a")}`,
	});

	reportFault(ctx, {
		tag: "UNTRACKED-CONSUMES",
		msg:
			`${consumes.untracked.length} typed \`consumes\` reference(s) in ${classesFile} ` +
			"name a file present on disk but not yet tracked by git:",
		key: "references",
		items: consumes.untracked,
		line: buildConsumesLine,
		severity: "warn",
		advice: "Commit the file, or drop the reference until it lands.",
	});
	return malformedConsumes;
}

/** @param {Run} r */
function checkPairScope(r) {
	const { ctx, classesJson, classesFile } = r;
	/* Assertion 26 (mantahostels#2647). NOT softened by `--map-dirty`, unlike the two
	 * blocks above: mantahostels#1193's softening covers a pointer whose TARGET moved in
	 * a commit the sidecar has not caught up with, and both ends of a
	 * pair-scope prefix sit inside one sidecar cell, so `docs/doc-map.md`'s
	 * dirtiness cannot produce this fault. Softening it would let the exact
	 * defect through the one gate that catches it: reordering a cell dirties
	 * the map, and pre-commit hands `--map-dirty` on that. */
	const pairScope = pairScopeFaults(classesJson);
	reportFault(ctx, {
		tag: "PAIR-SCOPE",
		msg:
			`${pairScope.length} \`consumes\` gloss(es) in ${classesFile} open with a ` +
			"`with <other-ref>:` prefix naming the wrong neighbour:",
		key: "references",
		items: pairScope,
		line: buildConsumesLine,
		advice:
			"A pair-scoped gloss reaches back exactly one reference, so the " +
			"prefix spells the one immediately before it, exactly as §A " +
			"prints it (`with §B243:`, `with mantahostels#631:`, a path in its backticks). " +
			"Repoint the prefix, move the reference back beside it, or drop " +
			"the prefix where the gloss no longer covers a neighbour. §A " +
			"renders from this file, so regenerate after fixing:\n" +
			`  ${generatorCommand("doc-map-section-a")}`,
	});
}

/**
 * Assertion 11's report, softened against a dirty map.
 * @param {Run} r
 * @param {string[]} pointerFaults
 * @param {boolean} mapDirty
 */
function reportPointerShape(r, pointerFaults, mapDirty) {
	const { ctx, mapPath } = r;
	reportFault(ctx, {
		tag: "POINTER-SHAPE",
		msg: `${pointerFaults.length} Section B pointer bullet(s) disagree with their sidecar:`,
		key: "pointers",
		items: pointerFaults,
		severity: mapDirty ? "warn" : "fail",
		advice: mapDirty
			? `${mapPath} has uncommitted edits — a half-rewritten entry is a live ` +
				"session mid-edit. Finish the edit and re-run."
			: "A `Restated in` or `Supersedes` bullet is a pointer and nothing " +
				"else: the prose lives in the sidecar it names, per path. Three " +
				"templates, and only three:\n" +
				"  - **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.\n" +
				"  - **Restated in:** none — <one clause saying why>.\n" +
				"  - **Supersedes:** see `docs/doc-map-superseded.json`.\n" +
				"Each of the first two may carry one suffix, the bare marker " +
				"` ⚠ **Restated-in is known incomplete**.`, which is what ages the " +
				"entry. Fix the count by editing the sidecar or the pointer — " +
				"never by deleting the bullet, which strands the key. A `Retired " +
				"vocabulary` bullet's free-text phrase count is held to the same " +
				"rule (mantahostels#2293): fix the count by editing " +
				"docs/doc-map-retired-vocabulary.json or the prose, whichever is " +
				"wrong.",
	});
}

/** @param {Run} r */
function checkNewEntryCap(r) {
	const { ctx, text, mapPath } = r;
	/*
	 * Assertion 14 (mantahostels#1384). The added-vs-edited discriminator is the id set of
	 * HEAD's map against the one handed in — computed in lib/doc-map.js off
	 * the same `sectionBEntryProseWords` counter both sides are measured by,
	 * never a second parser (mantahostels#1311).
	 *
	 * NOT softened by mapDirty — see the header note on assertion 14.
	 */
	const newOverCapOrNull = newOverCapEntries(text, mapPath);
	const newOverCap = newOverCapOrNull || [];
	if (newOverCapOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so whether ` +
				"this commit ADDS a §B entry could not be read — the 300-word " +
				"new-entry prose cap was not checked.",
		);

	reportFault(ctx, {
		tag: "NEW-ENTRY-OVER-CAP",
		msg:
			`${newOverCap.length} §B entr(ies) new since HEAD exceed the ` +
			`${PROSE_CAP_WORDS}-word prose cap:`,
		key: "entries",
		items: newOverCap,
		line: (e) =>
			`${e.id} — ${e.words} prose words, ${e.excess} over the ${PROSE_CAP_WORDS}-word cap`,
		advice:
			"Cut PROSE from the entry until it is at or under " +
			`${PROSE_CAP_WORDS} words, then commit again. Never cut \`Inputs\`, ` +
			"`Restated in`, `Supersedes`, `Settled at` or `Owner` — the skeleton " +
			"bullets are uncapped.\n" +
			"This refuses the entry's FIRST commit only (mantahostels#1350): editing an " +
			"existing over-cap entry is not gated. Do not pay by declining to " +
			"write the entry — CLAUDE.md's " +
			"duty to record a settled load-bearing fact is unconditional. A " +
			"`Over cap by ruling (#n)` marker never lifts this gate: no ruling " +
			"can predate the entry it exempts (mantahostels#2058).",
	});
	return newOverCap;
}

/**
 * @param {Run} r
 * @param {Figure[]} figures
 */
function checkAdmissions(r, figures) {
	const { ctx, text, mapPath, dataDir } = r;
	/*
	 * Assertion 29 (mantahostels#3225, building mantahostels#2888's design). Read the sidecar RAW:
	 * this file has no other consumer, so its schema has one owner and that
	 * owner is here.
	 *
	 * An ABSENT file is read as empty and the faults fall out — a commit
	 * adding an entry with no sidecar at all is exactly what this refuses.
	 * But .husky/pre-commit runs this checker over `git checkout-index`,
	 * so the same absence is what a session sees when it wrote the row and
	 * committed the map by pathspec without staging the sidecar. That
	 * session is told to add a row it already has, so the run names the
	 * absent path rather than leaving the advice to mislead it. Only a file
	 * that will not parse is BROKEN.
	 *
	 * NOT softened by mapDirty — see the header note on assertion 29.
	 */
	const admissionsFile = path.join(dataDir, DATA_FILES.admissions);
	/** @type {Record<string, unknown> | null} */
	let admissionsData = null;
	let admissionsAbsent = false;
	try {
		admissionsData = JSON.parse(fs.readFileSync(admissionsFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT") admissionsAbsent = true;
		else ctx.broken(`admissions data file unreadable — ${message}`);
	}
	if (admissionsAbsent)
		ctx.say(
			`\nNo ${DATA_FILES.admissions} in this commit's tree. If you wrote ` +
				"the row and committed the map by pathspec, the sidecar went " +
				"unstaged — commit it with the map rather than writing the row " +
				"again.",
		);

	/* The issue numbers each entry's own `Settled at` bullet names, so the
	 * row can be cross-checked against the entry it records. Parsed from
	 * `figures` rather than in the lib, keeping the bullet's spelling in the
	 * one place assertion 10 already reads it. */
	/** @type {Record<string, number[]>} */
	const settledIssues = {};
	for (const f of figures) {
		const nums = [
			...f.lines.join("\n").matchAll(/^\s*-\s*\*\*Settled at[^\n]*?#(\d+)/gm),
		].map((m) => Number(m[1]));
		if (nums.length > 0) settledIssues[f.id] = nums;
	}

	const unrecordedOrNull = unrecordedAdmissions(
		text,
		mapPath,
		admissionsData,
		settledIssues,
	);
	const unrecorded = unrecordedOrNull || [];
	if (unrecordedOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so whether ` +
				"this commit ADDS a §B entry could not be read — the admission " +
				"record was not checked.",
		);

	reportFault(ctx, {
		tag: "UNRECORDED-ADMISSION",
		msg:
			`${unrecorded.length} §B entr(ies) new since HEAD carry no conforming ` +
			`row in ${DATA_FILES.admissions}:`,
		key: "entries",
		items: unrecorded,
		line: (e) => `${e.id} — ${e.why}`,
		advice:
			"An entry enters §B when the founder confirms it belongs " +
			"(docs/doc-map.md §B preamble, on mantahostels#1728), and the confirmation is " +
			`written down before the entry is (mantahostels#2884). Add the row to ${DATA_FILES.admissions}:\n` +
			'  "B<n>": { "settledAt": <issue>, "confirmed": "<his answer>", ' +
			'"commentUrl": "https://github.com/<owner>/<repo>/issues/<issue>#issuecomment-<id>" }\n' +
			"`confirmed` is his answer verbatim, or the bare option letter where " +
			"he answered a lettered round — never your paraphrase of what he " +
			"meant. `commentUrl` is the comment recording it, on the issue " +
			"`settledAt` names: POST THAT COMMENT FIRST, because the permalink " +
			"does not exist until you have.\n" +
			"A CAP SPLIT is not an admission (mantahostels#2920), and its row says so — " +
			'`{ "capSplit": true, "from": "B<n>", "settledAt": <issue> }`, no ' +
			"confirmation, because nobody confirmed anything.\n" +
			"This refuses the entry's FIRST commit only, on assertion 14's " +
			"scope. Do not pay by declining to write the entry — CLAUDE.md's " +
			"duty to record a settled load-bearing fact is unconditional; the " +
			"payment is asking him, then writing down what he said.\n" +
			"WHAT THIS DOES NOT BUY (mantahostels#2884): the row is written by the same " +
			"session that writes the " +
			"entry, so it cannot prove the founder spoke. It buys a dated " +
			"primary artefact naming who confirmed what, and a URL that makes a " +
			"fabrication checkable in one click.",
	});
	return { unrecorded, unrecordedOrNull };
}

/** @param {Run} r */
function checkStaleMarkers(r) {
	const { ctx, text } = r;
	/*
	 * Assertion 21 (mantahostels#2058). A §B entry's own `Over cap by ruling (#n)` marker
	 * asserts it cannot reach 300 words without dropping a claim — an entry
	 * that has since fallen at or under the cap makes that assertion stale.
	 * `overCapEntries()` cannot see it: a fallen entry drops out of that list
	 * entirely, which is why this reads `staleExemptionMarkers()` instead,
	 * over every §B entry rather than the over-cap ones.
	 *
	 * NOT softened by mapDirty, despite what mantahostels#2058 asked for: the marker
	 * goes stale in exactly the commit that drains the entry, which is a
	 * dirty-map commit by construction — softening on that axis would warn
	 * on the one commit responsible and only ever FAIL a later, unrelated
	 * one. Safe to leave unsoftened because `staleMarkers` sits in the
	 * `data` envelope below: checker-new-faults.js reads it as gate
	 * material and a fault already at HEAD reads as inherited, so an
	 * unrelated commit is never refused for a staleness it did not create.
	 */
	const staleMarkers = staleExemptionMarkers(text);
	reportFault(ctx, {
		tag: "STALE-OVER-CAP-MARKER",
		msg:
			`${staleMarkers.length} §B entr(ies) carry an over-cap marker but ` +
			"are no longer over cap:",
		key: "entries",
		items: staleMarkers,
		line: (e) =>
			`${e.id} — ${e.words} prose words, marked exempt by #${e.exemptedAt}`,
		advice:
			"Drop the `Over cap by ruling (#n)` bullet: the entry now reads at " +
			`or under ${PROSE_CAP_WORDS} words without it, so nothing exempts ` +
			"it any longer. An entry carrying no marker asserts nothing about " +
			"whether its claims are cuttable (docs/doc-map.md §B preamble).",
	});
	return staleMarkers;
}

/** @param {Run} r */
function checkMalformedMarkers(r) {
	const { ctx, text } = r;
	/*
	 * Assertion 23 (mantahostels#2124). A line reaching for the `Over cap by ruling
	 * (#n)` marker and missing its spelling — the colon outside the bold,
	 * the bold absent, the bullet indented — leaves the entry reading as
	 * unexempted everywhere, with nothing anywhere saying so. Its author
	 * believes the entry exempt; the drain queue still asks them to pay it
	 * down, and assertion 22's no-growth gate, which runs on marked entries
	 * alone, never reaches it.
	 *
	 * WARN, never FAIL, for assertion 22's reasons — out of `count` and out
	 * of the `data` envelope — plus one of its own: the probe is lexical, so
	 * an entry whose prose genuinely opens a bullet with those words would
	 * be refused for saying something true. The direction of the fault
	 * carries no exemption wrongly, only loses one, so a WARN is the whole
	 * remedy needed. Replayed by `.husky/pre-commit` on a green run, like
	 * assertion 22's: the commit writing the misspelling is the one that
	 * needs to read it.
	 */
	const malformedMarkers = malformedExemptionMarkers(text);
	reportFault(ctx, {
		tag: "MALFORMED-OVER-CAP-MARKER",
		severity: "warn",
		msg:
			`${malformedMarkers.length} §B line(s) look like an over-cap ` +
			"marker but do not parse as one:",
		key: "lines",
		items: malformedMarkers,
		line: (e) => `${e.id} — ${e.line}`,
		advice:
			"Respell the bullet exactly `- **Over cap by ruling (#n):**` — a " +
			"top-level bullet, the whole leader bold, the colon INSIDE the " +
			"bold, and a bare issue number after the `#`. Where the line is " +
			"prose rather than an attempted " +
			"marker, reword its opening so it does not read as one.",
	});
}

/** @param {Run} r */
function checkGrownEntries(r) {
	const { ctx, text, mapPath } = r;
	/*
	 * Assertion 22 (mantahostels#2050). A marked entry may not GROW — the rule, its
	 * baseline and its two skips are in `grownExemptEntries`'s own header.
	 *
	 * WARN, never FAIL, so it stays out of `count` and out of the `data`
	 * envelope below — checker-new-faults.js reads `data` as gate material,
	 * which would make a WARN refuse a later commit by the back door. Out of
	 * the OK line too, which prints on a green run and would contradict a
	 * WARN above it.
	 *
	 * `--map-dirty` softens FAILs to WARNs and so cannot reach this one; the
	 * commit that grows an entry has a dirty map by construction.
	 *
	 * A WARN is held by `.husky/pre-commit`, which prints the report only on
	 * a non-zero exit — so the hook replays this block by name on a green
	 * run, as it already does for the untracked-row blocks (mantahostels#1300).
	 */
	const grownOrNull = grownExemptEntries(text, mapPath);
	const grown = grownOrNull || [];
	if (grownOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so this ` +
				"commit has no baseline and growth in an over-cap-by-ruling entry " +
				"was not checked.",
		);

	reportFault(ctx, {
		tag: "OVER-CAP-ENTRY-GREW",
		severity: "warn",
		msg:
			`${grown.length} §B entr(ies) marked over cap by ruling grew in ` +
			"this commit:",
		key: "entries",
		items: grown,
		line: (e) =>
			`${e.id} — ${e.was} → ${e.words} prose words, +${e.growth}, marked exempt by #${e.exemptedAt}`,
		advice:
			"Pay for the addition inside the same entry: cut surplus wording " +
			`until the entry is no larger than it was, per ${"`"}docs/doc-map.md${"`"} §B ` +
			"preamble. Never cut a claim to get there (mantahostels#1911, mantahostels#1935). Where the " +
			"entry genuinely holds no surplus left, the addition stands: nothing " +
			"here refuses the commit, and the next commit's baseline is the entry " +
			"as this one leaves it.",
	});
}

/** @param {Run} r */
function checkDroppedMarkers(r) {
	const { ctx, text, mapPath } = r;
	/*
	 * Assertion 24 (mantahostels#2227, option (A)).
	 *
	 * WARN, never FAIL, for assertion 22's reasons — out of `count` and out
	 * of the `data` envelope, which checker-new-faults.js reads as gate
	 * material — plus one of its own: un-marking a still-fat entry is a real
	 * act, the ruling revisited and the entry sent back to the drain queue.
	 * A FAIL would bar it with no escape hatch.
	 */
	const droppedOrNull = droppedExemptionMarkers(text, mapPath);
	const dropped = droppedOrNull || [];
	if (droppedOrNull === null)
		ctx.say(
			`\nHEAD holds no copy of ${mapPath} to compare against, so this ` +
				"commit has no baseline and a dropped over-cap-by-ruling marker " +
				"was not checked.",
		);

	reportFault(ctx, {
		tag: "OVER-CAP-MARKER-DROPPED",
		severity: "warn",
		msg:
			`${dropped.length} over-cap §B entr(ies) lost the marker the ` +
			"baseline carried:",
		key: "entries",
		items: dropped,
		line: (e) =>
			`${e.id} — ${e.words} prose words, marked exempt by #${e.exemptedAt} until this commit`,
		advice:
			"Deleted by accident? Put the `- **Over cap by ruling (#n):**` " +
			"bullet back. MISSPELLED rather than deleted — a " +
			"MALFORMED-OVER-CAP-MARKER above naming the same entry — then " +
			"respell that line and add no second bullet: a valid one beside it " +
			"silences that block and leaves the bad line in the file. " +
			"Un-marked on purpose, the ruling revisited? The entry is back in " +
			"the drain queue and this WARN is the whole of it: nothing refuses " +
			"the commit, and draining to " +
			`${PROSE_CAP_WORDS} words or fewer is not reported here at all. ` +
			"What the marker was holding: it is the ratchet's baseline, so an " +
			"entry that loses it may grow unwatched, and re-adding it later is " +
			"exempt as a first marking.",
	});
}

/** @param {Run} r */
function checkLedgerCap(r) {
	const { ctx, text, mapPath } = r;
	/*
	 * Assertion 15 (mantahostels#1640). Gated rather than left to the prose in §5 that
	 * states it, which three concision passes failed to hold.
	 *
	 * NOT softened by mapDirty — see the header note on assertion 15.
	 */
	const overCapLedgerOrNull = overCapLedgerEntries(text);
	const overCapLedger = overCapLedgerOrNull || [];
	if (overCapLedgerOrNull === null)
		ctx.say(
			`\n${mapPath} carries no \`Sheds paid, most recent first:\` line, so ` +
				`the ${LEDGER_ENTRY_CAP_BYTES} B shed-ledger entry cap was not checked.`,
		);

	reportFault(ctx, {
		tag: "LEDGER-ENTRY-OVER-CAP",
		msg:
			`${overCapLedger.length} shed-ledger entr(ies) exceed the ` +
			`${LEDGER_ENTRY_CAP_BYTES} B cap:`,
		key: "entries",
		items: overCapLedger,
		line: (e) =>
			`${e.label} — ${e.bytes} B, ${e.excess} over the ${LEDGER_ENTRY_CAP_BYTES} B cap`,
		advice:
			"Only the NEWEST entry is written in full. Compact each of the others " +
			"to five things: the tranche's issue number, its " +
			"date, its net byte figure, what it did in one clause, and its named " +
			"residual — the conclusion about a shed candidate that stops a later " +
			"session re-proposing it. Where the displaced entry carried a " +
			"prediction, its verdict is a sixth element beside the residual, " +
			"never inside it (mantahostels#1864); nothing else.\n" +
			"The full narrative stays recoverable from the tranche's own issue " +
			"and from `git log -p`.",
	});
	return { overCapLedger, overCapLedgerOrNull };
}

/** @param {Run} r */
function checkTriggerVerdict(r) {
	const { ctx, text, mapPath } = r;
	/*
	 * Assertion 16 (mantahostels#1788). A commit that adds pool bytes and writes NO entry
	 * leaves the ledger's newest entry exactly as it found it, so a check
	 * reading only the newest entry's text would pass every later tranche as
	 * soon as one entry carried the marker.
	 *
	 * NOT softened by mapDirty — see the header note on assertion 16.
	 */
	const revs = readCommittedRevs();
	const poolDelta = stagedPoolDelta(revs);
	const ledgerEntries = shedLedgerEntries(text);
	/** @type {{ label: string, fault: string }[]} */
	let triggerFaults = [];
	if (poolDelta === null)
		ctx.say(
			"\nNo committed rev resolves, so whether this commit adds " +
				"always-loaded pool bytes could not be read — the §5 trigger " +
				"verdict was not checked.",
		);
	else if (ledgerEntries === null)
		ctx.say(
			`\n${mapPath} carries no \`Sheds paid, most recent first:\` line, so ` +
				"the §5 trigger verdict was not checked.",
		);
	else if (poolDelta > 0)
		triggerFaults = triggerVerdictFaults(
			ledgerEntries,
			revs
				.map((rev) => shedLedgerEntries(readMapTextAt(rev, mapPath) || ""))
				.filter((e) => e !== null),
		);

	reportFault(ctx, {
		tag: "LEDGER-TRIGGER-VERDICT",
		msg:
			`this commit adds ${poolDelta} B to the always-loaded pool and §5's ` +
			"ledger does not answer the placement test's step 2:",
		key: "entries",
		items: triggerFaults,
		line: (e) => `${e.label} — ${e.fault}`,
		advice:
			"docs/doc-map.md §Capture and placement §4 already obliges a tranche " +
			"adding pool bytes to name its shed in the same commit. This adds one " +
			"line to that entry: the trigger the rule binds behind, written\n" +
			`  ${TRIGGER_VERDICT_MARKER} <the nearest observable event — a tool ` +
			"call, or class of calls — before the decision the rule binds>\n" +
			"or, where §3's step 2 names none — which is the pool's only " +
			"entrance —\n" +
			`  ${TRIGGER_VERDICT_MARKER} none nameable — <one clause saying why>\n` +
			"It sits in the NEWEST entry, which assertion 15 exempts from the " +
			`${LEDGER_ENTRY_CAP_BYTES} B cap, so this costs no compaction. ` +
			"Nothing here judges whether " +
			"the trigger really fires: the gate is that step 2 was answered.",
	});
	return { poolDelta, ledgerEntries, triggerFaults };
}

/**
 * @param {Run} r
 * @param {string[][] | null} ledgerEntries
 */
function checkCompactionVerdict(r, ledgerEntries) {
	const { ctx, mapPath } = r;
	/*
	 * Assertion 20 (mantahostels#1968, on mantahostels#1890's ruling). Assertion 15 gates the
	 * compacted entry's BYTES and cannot see whether the verdict those bytes
	 * owe is present; assertion 16's trigger verdict is scoped to the newest
	 * entry and never reaches a compaction.
	 *
	 * NOT softened by mapDirty: the commit landing a tranche IS the dirty-map
	 * case.
	 */
	const compactionFaults =
		ledgerEntries === null
			? []
			: compactionVerdictFaults(
					ledgerEntries,
					shedLedgerEntries(readMapTextAt("HEAD", mapPath) || ""),
				);

	reportFault(ctx, {
		tag: "LEDGER-COMPACTION-VERDICT",
		msg:
			"this commit compacts a ledger entry that carried a prediction, and " +
			"§5's verdict is not there to find:",
		key: "entries",
		items: compactionFaults,
		line: (e) => `${e.label} — ${e.fault}`,
		advice:
			"§5: a tranche compacted to five elements carries a SIXTH where the " +
			"entry it displaces carried a prediction — the verdict, beside the " +
			"named residual and never inside it (mantahostels#1864), so a marker is there " +
			"to find it by. Write it onto the compacted entry:\n" +
			`  ${VERDICT_MARKER}: held** — <subject> fired <N> times since <date>\n` +
			"It asserts RETRIEVAL and nothing else (mantahostels#1887). Where the prediction " +
			"has not ripened, the audit stamp is the verdict — " +
			`\`${VERDICT_MARKER}: not yet ripe**\` plus the reading — and the live ` +
			"claim is carried forward into your own entry (mantahostels#1888).\n" +
			`The floor is ${TRIGGER_VERDICT_MIN_WORDS} words after the marker, so ` +
			"a pasted marker does not clear the gate. The verdict costs 77-152 B " +
			`against the ${LEDGER_ENTRY_CAP_BYTES} B cap assertion 15 gates (mantahostels#1889).`,
	});
}

/**
 * @param {Run} r
 * @param {{
 *   badClasses: ReturnType<typeof badClassEntries>,
 *   badReaders: ReturnType<typeof badReaderEntries>,
 *   malformedConsumes: ConsumesFault[],
 * }} faults
 */
function loadClassesUnlessFaulted(
	r,
	{ badClasses, badReaders, malformedConsumes },
) {
	const { ctx, classesFile } = r;
	/* The sidecar was read, parsed and vocabulary-checked above assertion 1.
	 * loadDocClasses re-reads it for the rest of its shape, and its throw is
	 * BROKEN — the drift assertion 19 has already ruled out is the one fault
	 * of the set a session can fix, so skip the load while 19 stands rather
	 * than replacing its FAIL with an abort. */
	const classes =
		badClasses.length > 0 ||
		badReaders.unknown.length > 0 ||
		malformedConsumes.length > 0
			? null
			: loadDocClasses(classesFile);
	if (!classes)
		ctx.say(
			`\n${badClasses.length} unknown class token(s), ` +
				`${badReaders.unknown.length} unknown reader token(s) and ` +
				`${malformedConsumes.length} malformed \`consumes\` reference(s) in ` +
				`${classesFile}, so §A's rendered bytes and the \`role\` word cap ` +
				"were not checked.",
		);
	return classes;
}

/** `t` above its `## Section B` heading, all of it where it has none. */
const aboveSectionB = (/** @type {string} */ t) => {
	const [above] = t.split(/^## Section B/m);
	if (above === undefined)
		throw new Error("splitting the map at Section B yielded no part");
	return above;
};
/* A drift that changes no row's own text — a row in the wrong subsection, or two rows out of
 * sorted order — leaves this list empty and is reported by the count. */
const parseRowLines = (/** @type {string} */ t) => {
	const region = aboveSectionB(t).split(/^## Section A/m)[1] || "";
	/** @type {Map<string, string>} */
	const byPath = new Map();
	for (const line of region.split("\n")) {
		// Both shapes a §A register comes in: a table row, and a
		// register-list line (mantahostels#2743). Reading only the first would let
		// drift inside a listed subsection fall through to the coarse
		// "row order or subsection placement differs" fault below.
		const [rowPath] = registerRowPaths(line);
		const listed = registerListPath(line);
		if (rowPath !== undefined) byPath.set(rowPath, line);
		else if (listed) byPath.set(listed, line);
	}
	return byPath;
};

/**
 * @param {string} mapPath
 * @param {string} text
 * @param {string} renderedText
 */
function sectionAFaults(mapPath, text, renderedText) {
	/** @type {{ path: string, fault: string }[]} */
	const renderFaults = [];
	if (renderedText === text) return renderFaults;
	const have = parseRowLines(text);
	const want = parseRowLines(renderedText);
	for (const [p, line] of want)
		if (have.get(p) !== line)
			renderFaults.push({
				path: p,
				fault: have.has(p) ? "row differs" : "row missing",
			});
	for (const p of have.keys())
		if (!want.has(p))
			renderFaults.push({ path: p, fault: "row has no sidecar key" });
	if (renderFaults.length === 0)
		renderFaults.push({
			path: mapPath,
			fault: "row order or subsection placement differs",
		});
	return renderFaults;
}

/*
 * Assertion 17 (mantahostels#1863). It reads the map text this run already holds, so a
 * §A row living only in the working tree is compared, not skipped —
 * mantahostels#551's trap.
 */
/**
 * @param {Run} r
 * @param {Classes} classes
 */
function checkSectionA(r, classes) {
	const { ctx, text, mapPath, classesFile } = r;
	const hasRegisterTable = aboveSectionB(text)
		.split(/^## Section A/m)
		.slice(1)
		.some((section) => section.includes(REGISTER_HEADER));
	if (classes && !hasRegisterTable)
		ctx.say(
			`\n${mapPath} §A carries no \`${REGISTER_HEADER}\` table, so its ` +
				"rendered bytes were not checked.",
		);

	const renderedText =
		classes && hasRegisterTable ? renderSectionA(text, classes) : text;
	const renderFaults = sectionAFaults(mapPath, text, renderedText);

	reportFault(ctx, {
		tag: "SECTION-A-DRIFT",
		msg: `§A does not match what the generator renders from ${classesFile}:`,
		key: "renderFaults",
		items: renderFaults,
		line: (e) => `${e.path} — ${e.fault}`,
		advice:
			"§A is rendered, not hand-written (docs/doc-map.md §Authority " +
			"classes). Put the change in the sidecar, then regenerate:\n" +
			`  ${generatorCommand("doc-map-section-a")}\n` +
			"A NEW document is registered with `node scripts/register-doc.js " +
			"<path> --class <token> --section <name>`, which writes the key the " +
			"row renders from. `--section` must spell a subsection §A already " +
			"has; add `--new-section` to mint one.",
	});
	return { hasRegisterTable, renderFaults };
}

/**
 * @param {Ctx} ctx
 * @param {Classes} classes
 */
function checkRoleCap(ctx, classes) {
	/* Assertion 18 (mantahostels#1863). The 300-word cap on a surviving `role` override,
	 * in assertion 14's shape. */
	const overCapRoleList = classes ? overCapRoles(classes) : [];
	reportFault(ctx, {
		tag: "ROLE-OVER-CAP",
		msg:
			`${overCapRoleList.length} \`role\` override(s) exceed the ` +
			`${ROLE_CAP_WORDS}-word cap:`,
		key: "overCapRoles",
		items: overCapRoleList,
		line: (e) =>
			`${e.path} — ${e.words} words, ${e.excess} over the ${ROLE_CAP_WORDS}-word cap`,
		advice:
			"A `role` override exists to carry what the generated default " +
			"cannot: a ⚠ correction or supersession, a ruling citation, or a " +
			"research note's date and headline (mantahostels#1850's keep rule). Cut it back " +
			"to that, in the sidecar, and regenerate. The document itself is " +
			"where the detail belongs — §A points at it, never restates it.",
	});
	return overCapRoleList;
}

/** @param {Ctx} ctx */
function countFailItems(ctx) {
	/* The summary count, read off the findings rather than hand-summed beside
	 * them (mantahostels#3545): every finding here comes through reportFault, which
	 * attaches its item list as the single array in the payload, so a new FAIL
	 * counts itself and a WARN never counts. Three exclusions are deliberate
	 * and fall out of that, all being WARNs: an in-grace UNCOVERED/DEAD-ENTRY
	 * half (mantahostels#1785), an UNTRACKED-ENTRY, and a pointer fault against a
	 * dirty map (mantahostels#1193). The summary reads as what refused the
	 * commit; the exit comes from the severities (lib/check.js runCheck's
	 * `worst()` fold, then exitFor). */
	const failItemCount = ctx.findings.reduce((total, finding) => {
		if (finding.severity !== "FAIL") return total;
		const items = Object.values(finding).find((v) => Array.isArray(v));
		if (items) return total + items.length;
		/* Unreachable while reportFault is this file's only raiser, so reaching
		 * it means the count is reading a shape nobody designed it for, where
		 * counting the finding as one problem may under-report. */
		ctx.say(
			`${finding.tag} carries no item list — counted as one problem, and ` +
				"the summary count may now under-report.",
		);
		return total + 1;
	}, 0);
	return failItemCount;
}

runCheck({
	name: "doc-map",
	usage:
		"node check-doc-map.js [<doc-map.md>] [--data-dir <dir>] [--root <dir>]",
	valueFlags: ["--data-dir", "--root"],
	flags: ["--map-dirty"],
	run(/** @type {Ctx} */ ctx) {
		const { root, underRoot, mapPath, dataDir } = resolveLocations(ctx);
		skipOnConflict(ctx);
		const { text, stamp, entries } = readMap(ctx, mapPath);
		const sidecar = readClassSidecar(ctx, { dataDir, underRoot });
		const { allTracked, resolvable } = walkTree(ctx, root);
		/** @type {Run} */
		const r = {
			ctx,
			underRoot,
			mapPath,
			dataDir,
			text,
			entries,
			...sidecar,
			allTracked,
			resolvable,
			tracked: inScope(allTracked),
			presentUntracked: untrackedMatcher(),
		};
		const { tracked } = r;

		const { uncoveredSplit, deadSplit, untracked } = checkCoverage(r);
		const { badClasses, badReaders } = checkSidecarVocabulary(r);
		reportUntrackedEntries(ctx, untracked);
		const { routes, reached, deadRoutes, untrackedRoutes } = checkRoutes(r);
		const routeIdFaults = checkRouteIds(r);
		const {
			restatementData,
			figures,
			restatementPaths,
			figuresRestated,
			deadRestatements,
		} = checkRestatements(r);
		const lineLocators = checkLineLocators(r, { restatementData, figures });
		const deadAnchors = checkDeadAnchors(r, restatementData);
		const deadRefs = checkSectionRefs(r);
		const unreached = reportCensus(r, {
			restatementPaths,
			figuresRestated,
			figures,
			reached,
		});

		const sectionBWords = roundedSectionBWords(text);

		const { headings, seen, duplicates } = checkDuplicateIds(r);
		const rowDuplicates = checkDuplicateKeys(r);
		const classesDrift = checkCanonicalSidecar(r);
		const strays = checkStrays(ctx, headings);
		const settledMissing = checkSettledAt(ctx, figures);
		const pointers = checkPointerShapes(r, { restatementData, figures });
		const mapDirty = isMapDirty(ctx, mapPath);
		const pointerFaults = [
			...pointers.pointerFaults,
			...reconcilePointerSidecars(r, figures, pointers),
		];
		checkHighWaterMark(r);
		const malformedConsumes = checkConsumes(r, { headings, mapDirty });
		checkPairScope(r);
		reportPointerShape(r, pointerFaults, mapDirty);
		const newOverCap = checkNewEntryCap(r);
		const { unrecorded, unrecordedOrNull } = checkAdmissions(r, figures);
		const staleMarkers = checkStaleMarkers(r);
		checkMalformedMarkers(r);
		checkGrownEntries(r);
		checkDroppedMarkers(r);
		const { overCapLedger, overCapLedgerOrNull } = checkLedgerCap(r);
		const { poolDelta, ledgerEntries, triggerFaults } = checkTriggerVerdict(r);
		checkCompactionVerdict(r, ledgerEntries);
		const classes = loadClassesUnlessFaulted(r, {
			badClasses,
			badReaders,
			malformedConsumes,
		});
		const { hasRegisterTable, renderFaults } = checkSectionA(r, classes);
		const overCapRoleList = checkRoleCap(ctx, classes);
		const failItemCount = countFailItems(ctx);

		return {
			okLine:
				`doc map covers all ${tracked.length} tracked files in scope ` +
				`(${entries.length} register entries, ${routes.length} question routes ` +
				"with no id gap, " +
				"every route path and every §B restatement path live, no line-number locator, every quoted anchor held, every doc-map section reference live; " +
				`${seen.size} distinct §B entry ids, each with a \`Settled at\` bullet ` +
				"and a sidecar-agreeing pointer; no id at or below the high-water mark reused, and none removed above it; " +
				`no entry new since HEAD over the ${PROSE_CAP_WORDS}-word prose cap; ` +
				// Silent where HEAD held no copy to compare against, the ledger
				// clause's reasoning: an OK line claiming the record held, above a
				// `ctx.say` that it went unchecked, contradicts.
				(unrecordedOrNull === null
					? ""
					: "every entry new since HEAD carrying an admission row; ") +
				"no stale over-cap marker" +
				// Silent where there was no ledger to read: an OK line claiming the
				// cap held, above a `ctx.say` that it went unchecked, contradicts.
				(overCapLedgerOrNull === null
					? ""
					: "; every shed-ledger entry but the newest at or under " +
						`${LEDGER_ENTRY_CAP_BYTES} B`) +
				(poolDelta !== null && poolDelta > 0 && ledgerEntries !== null
					? `; §5's newest ledger entry answers step 2 for this commit's ` +
						`${poolDelta} B of new pool bytes`
					: "") +
				(classes && hasRegisterTable
					? "; §A matches the generator against " +
						`${Object.keys(classes).length} sidecar rows, every \`role\` ` +
						`override at or under ${ROLE_CAP_WORDS} words, every ` +
						"pair-scope prefix naming the reference beside it"
					: "") +
				"); " +
				`§B ~${sectionBWords.toLocaleString("en-GB")} ` +
				`words — ${stamp[0].split(" · ")[0]}`,
			noun: "doc-map problem(s)",
			count: failItemCount,
			data: {
				// Out-of-grace only (mantahostels#1785): lib/fault-profiles.js's `doc-map`
				// profile diffs every item here as gate material — it has no
				// `gating` predicate, unlike `findings` — so an in-grace item left
				// in would be flagged "not in baseline" and refuse a commit the
				// moment the doc map ALSO carries any unrelated, already-FAILing
				// entry, exactly the split-commit-pair case grace exists to let
				// through. The in-grace half is still reported, under its own
				// UNCOVERED-GRACE/DEAD-ENTRY-GRACE tag in `findings`.
				uncovered: uncoveredSplit.outOfGrace,
				dead: deadSplit.outOfGrace,
				untracked,
				duplicates,
				strays,
				rowDuplicates,
				pointerFaults,
				deadRoutes,
				untrackedRoutes,
				deadRestatements,
				lineLocators,
				deadAnchors,
				sectionRefs: deadRefs,
				routeIdFaults,
				settledMissing,
				newOverCap,
				unrecorded,
				staleMarkers,
				overCapLedger,
				triggerFaults,
				renderFaults,
				overCapRoles: overCapRoleList,
				classesDrift,
				unreached,
				tracked: tracked.length,
				entries: entries.length,
				routes: routes.length,
			},
		};
	},
});
