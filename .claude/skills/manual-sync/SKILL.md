---
name: manual-sync
description: "Operating manual sync against the roadmap and the repo. Use when syncing docs/operating-manual.md, landing one settled fact into it between syncs, or asked whether it has drifted."
---

# Operating manual sync

The operating manual is the persistent context document supplied to Claude
sessions advising on the adopter's strategy. The roadmap is the source of truth
for card state; the manual is NOT a roadmap summary — it is the synthesised
reasoning underneath it. Most roadmap changes should produce no manual edit.
The manual can also fall out of date with no roadmap change at all — a file
rename, a tooling port, an effort-guide edit, a removed connector — so this
routine checks repo reality, not only the roadmap diff.

**Gate first, in every mode:** `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workflow-core-config.js module
governance roadmap`. Where it exits non-zero, relay what it printed and stop —
the manual is roadmap-coupled, so it has no sync with either module off (workflow-core#418).

## Anchors

Line 3 of docs/operating-manual.md ends:
`Reviewed against roadmap v<VERSION> (<DATE>), roadmap commit <ROADMAP_SHA> · reviewed against repo at <REPO_SHA>.`

Two anchors, both mandatory — neither is optional. **Both record what was
reviewed through, not what was written from** (mantahostels#1645):
- `<ROADMAP_SHA>` — the last docs/reference-roadmap.html commit the manual was
  reviewed through. Anchors the roadmap diff
  (`git log/diff <ROADMAP_SHA>..HEAD -- docs/reference-roadmap.html`). Which
  roadmap version the prose was *synthesised* from is not recorded at all.
- `<REPO_SHA>` — the repo HEAD the manual was last reviewed against, whole-tree.
  Anchors the unscoped survey and the repo-reality pass
  (`git log <REPO_SHA>..HEAD --oneline`, all paths).

The paragraph immediately below carries the **Corrections since last sync**
list — targeted corrections made between runs, which advance neither anchor. See
**Targeted-correction mode**.

They differ whenever non-roadmap commits (renames, tooling/surface moves,
effort-guide or skill edits) have landed since the last roadmap commit — the
normal case, and the reason two anchors exist.

## Procedure

The findings intake and passes (a)–(c) run every time, whether or not any diff
is non-empty.

1. Read both anchors from line 3: `<ROADMAP_SHA>` and `<REPO_SHA>`.

2. **Findings intake — before any diff work.** A session that finds a manual
   fact wrong but cannot land it under **Targeted-correction mode** files a
   GitHub issue instead (ruled at mantahostels#27). mantahostels#173 sat open unread for want of this
   step:

   ```
   gh issue list --state open --label manual-finding
   ```

   The label is unenforced, so also eyeball
   `gh issue list --state open --search '"operating manual" in:title,body'` —
   most hits merely mention the manual — and label any real finding it turns up.
   Read each in full (`gh issue view <n> --comments`).

   A finding is a **candidate**, classified like any diff hunk below, with the
   issue number as its source.

3. **(a) Roadmap diff.**
   `git log <ROADMAP_SHA>..HEAD --oneline -- docs/reference-roadmap.html`, then
   `git diff <ROADMAP_SHA>..HEAD -- docs/reference-roadmap.html`. Classify every
   hunk as exactly one of:
   - MANUAL-RELEVANT — changes a decision, constraint, core assumption,
     confidence band, economic figure, phase gate, principle, or rejected
     alternative the manual states or depends on.
   - STATE-ONLY — card status flips, log entries, effort/model tags,
     re-ordering, dependency edits, typos, the version bump itself. These never
     touch the manual.

4. **(b) Repo-reality pass** — independent of any diff, run unconditionally.
   Do not grep the manual for path-like tokens: `${CLAUDE_PLUGIN_ROOT}/scripts/check-manual-freshness.js`
   existence-checks every path the manual cites, and its misses reach you on
   `npm run status` (mantahostels#1149).
   - **Surface-claim check.** Every execution-surface claim (Chat / Code /
     Cowork / Design) must match ${CLAUDE_PLUGIN_ROOT}/docs/effort-guide.md and the live
     ${CLAUDE_PLUGIN_ROOT}/.claude/skills/*/SKILL.md as they currently stand. Flag any surface the
     manual names that the tooling has since moved.
   - **Enumeration check.** Every "both / two / three X" count or explicit list
     (custom skills, ESPs, streams, differentiators) must match reality.

5. **(c) Unscoped survey.**
   `git log <REPO_SHA>..HEAD --oneline` — all paths, not just the roadmap. Read
   every commit subject; for any that could touch a fact the manual states (doc
   renames, tooling ports, effort-guide changes, connector/infra moves), open it
   and classify as in (a).

6. **Section 8 (Current) reconciliation** against live roadmap state at HEAD, on
   every run, whether or not this window's diff touched it. Read the roadmap at
   HEAD, not just the diff — Section 8 accumulates drift from commits predating
   the anchor. This is the only section edited without a per-hunk proposal, but
   every change is recorded in the commit message with its roadmap evidence.

7. **Sections 1–7 (Timeless/Stable): propose, don't edit unilaterally.** Surface,
   per finding: the source (roadmap card ID, path miss, or commit SHA), what
   changed, the manual section affected, proposed replacement text, one-line
   rationale. Also record any contradiction found even where no change is
   proposed. Bias to under-editing; ambiguous → propose, don't edit.

   **Call the Skill tool with "concision-pass" over the proposed replacement
   text before delivering it**, fixed point `<REPO_SHA>`. Cuts apply to text this sync proposes; bloat
   found in the standing manual is a finding for the report, never a silent
   deletion.

8. **Delivery.** Every run is interactive: present the full delta list
   (roadmap-relevant + repo-reality findings), get approval, then commit direct
   to `main` — no branch, no PR, no report file.

   **Interactive means a session presents its delta list and gets approval — not
   that the founder runs the skill.** Any Claude Code session may invoke it, so
   a finding routed here is `takes:implement` work, never `takes:human`.

   **There is no unattended mode** (mantahostels#813). Nothing refreshes the manual on a
   schedule, on a version diff, or on any automatic trigger: a session runs this
   skill, or the manual stays stale. What is automatic is **detection only**, and
   neither detector edits the manual. So **never wait for a sync to happen by
   itself, and never read a staleness issue or an `npm run status` drift line
   as evidence that something is already fixing it.** The accepted cost is that
   nothing syncs the manual while the founder is away from the machine; the
   consequence for the commit rules is that this repo has **no** route that
   opens a PR on `main`, and the no-PR rule has no exception. Staleness reaches a human two ways,
   neither of which syncs anything by itself — the `roadmap-digest`
   staleness step, which runs on each of the four daily sweeps and files one
   *Operating manual is stale against the roadmap* issue on FAIL, and the
   `npm run status` line from `check-manual-freshness.js`.

   **Archive paths are fixed, not configured.** A run writes no report, but one
   written by hand goes in `docs/archive/sync-reports/`, a proposal in
   `docs/archive/sync-proposals/`; no config key moves them and `init` creates
   neither, so the first write makes the folder (`mkdir -p`).

   **Render, if the adopter declares a step.** Run
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/workflow-core-config.js manual-render` immediately before
   the commit, after this run's last manual edit — the corrections-line reset
   and anchor stamp below included, or the page lags the manual. Exit 1
   (`SKIP`) means none is declared. Exit 2 (`BROKEN`) means `manualRender` in
   `.claude/workflow-core.json` is malformed: relay it and stop before
   committing. Exit 0 prints the command on line 1 and each file it writes on
   the lines after: run the command, and where it fails, stop before
   committing.

   **Commit the manual by pathspec** — `git commit -m "…" -- docs/operating-manual.md`,
   plus every output the render step printed, never `git add` first — except
   `git add -- <output>` for an output git does not track yet, which a
   pathspec commit refuses. A targeted correction renders and commits the same
   way.

   **Release the manual once committed.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/session-arbiter.js
   release docs/operating-manual.md`, plus anything else this run wrote under
   `docs/` or `.claude/`. Release refuses a dirty file, so it comes after the
   commit; a later write re-claims automatically.

   **Dispose of every finding read at the intake.** Comment on each issue saying
   **applied** — naming the manual section and the commit subject — or
   **declined**, with the reason, then close it once the edit is on `main`. The
   close follows `docs/agents/issue-tracker.md`.

   **Clear the corrections line.** Reset line 4 to
   `**Corrections since last sync:** none.` — the survey this run just did
   supersedes every targeted correction logged since the last one. See
   **Targeted-correction mode** below.

   **Stamp anchors.** Both advance on every run that commits, a clean run's
   anchor-only bump included, so neither frontier ever re-reviews cleared
   commits. `<ROADMAP_SHA>` and the `v<VERSION>` (`<DATE>`) beside it advance to
   the newest roadmap commit this run's diff pass actually read through — edits
   or none, a clean run having still reviewed through it. Record what you read, never
   roadmap HEAD as it stands at commit time, which a concurrent session may have
   moved past you. `<REPO_SHA>` advances to the HEAD reviewed against.

## Targeted-correction mode

Use this when a single, already-settled fact needs to land in the manual now,
rather than waiting for a run nobody is due to make (mantahostels#82, which ruled the mode
in after three settled corrections stalled for want of a channel). It is not a
shortcut for a sync: it deliberately **skips the findings
intake and passes (a) roadmap diff, (b) repo-reality and (c) unscoped survey**,
so it never claims a review it did not do.

**Six rules, all binding:**

1. **A cited source, or no edit.** Every correction names where the fact was
   settled: a GitHub issue number, a roadmap card id, or a `doc-map.md` §B entry.
2. **Neither anchor advances.** `<ROADMAP_SHA>` and `<REPO_SHA>` stay exactly as
   they were. The freshness clock keeps running, and the next full run still owes
   the real survey.
3. **Log it under the stamp.** Append a bullet to the **Corrections since last
   sync** line (format below). The next full run applies its own findings and
   resets that line to `none.` — clearing it is part of the run, not optional.
4. **Section 8 (Current) is out of scope.** Step 6 of the full routine
   reconciles §8 unilaterally against roadmap HEAD, so a targeted edit there is
   clobbered on the next run. Corrections to §8 belong in a sync.
5. **Never narrow a confidence band or remove a stated uncertainty.** Widening a
   band, adding an uncertainty, or adding a new §4 assumption is allowed;
   tightening one is a judgement only the full survey is entitled to make.
6. **The Conventions block below applies unchanged**, run against the one hunk.

### The corrections line

Its own paragraph in `docs/operating-manual.md`, immediately under the
provenance-stamp paragraph:

```
**Corrections since last sync:** none.
```

With corrections outstanding, the bullets follow on their own lines:

```
**Corrections since last sync:**
- 2026-08-02 · repo ab08831 · source founder ruling · §4 — weekly review slot recorded as 90 minutes.
```

Each bullet is `- <YYYY-MM-DD> · repo <REPO_SHA> · source <where it was settled> — <what changed>`.
The recorded `<REPO_SHA>` is the repo anchor **as it stands in the stamp**.

`${CLAUDE_PLUGIN_ROOT}/scripts/check-manual-freshness.js` enforces the line's presence, that every
bullet names a source, and that no bullet's recorded anchor has been left behind
by an advanced stamp.

## Conventions — binding on every mode

- Preserve the Timeless / Stable / Current section tags.
- Preserve Section 4's schema: bold falsifiable assumption first, then
  *Confidence* / *Evidence* / *Implication*. Where a field has no content,
  state it as absent rather than dropping it.
- Never re-synthesise the manual from scratch. Edit surgically.
- Never remove a stated uncertainty or narrow a confidence band without a
  roadmap hunk that justifies it.
- Ambiguous diff → propose, don't edit. Bias to under-editing.
- **A fact settling here owes the `docs/doc-map.md` §B question.** A
  load-bearing fact about the adopter's world written here with no §B entry — a figure, a
  licence condition, a threshold, a condition reopening a settled decision —
  has no owner and no restated-in trail. Say the verdict on the settling issue,
  `§B: yes` or `§B: no, because …`, before the commit (mantahostels#3219).
- The provenance line is the manual's only version anchor, and it now carries
  **two SHAs — roadmap and repo, both mandatory** (see Anchors). Never
  reintroduce a version number elsewhere in the document, and never collapse the
  stamp back to a single SHA.
- Proposed replacement text must not exceed what it replaces by more than
  ~30%. The manual carries enduring reasoning, not card-level evidence:
  node-specific figures, coefficients and per-property detail belong in the
  roadmap. State what is true; do not narrate what was previously wrong,
  except where a superseded figure circulates in other documents.
