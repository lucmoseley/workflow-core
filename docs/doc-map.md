# workflow-core document map

v1.13 · 23 October 2026

> Three things live here. **Section A** says what each document is and who may edit it, rendered from `docs/doc-map-classes.json` by `npm run gen:doc-map-section-a`. **Section B** is the figure registry: a number or claim restated in more than one place, with its owner. **Section C** routes a question to the document that answers it. `scripts/check-doc-map.js` gates all three, and refuses a `docs/doc-map.md §<name>` reference that names no section here, outside binary assets and tests. **§The propagation pass** carries a settled fact to every copy of it; **§Capture and placement**, last, says where a settled fact goes and caps what every session loads.

---

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

**Registering a document owes an orphan check** (mantahostels#3198), unless its subsection is in `register-doc.js`'s `ORPHAN_CHECK_EXEMPT` — an exemption list, so a subsection minted later owes the check by default. Read the file for a commitment — work, a decision or a constraint carrying a completion condition — that names no card and no issue. Dispose of a hit in the same session: a card through `roadmap-edit`, a trigger line on the card that fires it, or the document's own gap line gaining its owner. A ruling not carded goes to the founder priced first. **Named residual:** a key written by direct edit, a bulk write and a re-sectioning meet no reminder.

**A `consumes` gloss scopes to the reference it hangs on.** Where it also covers the reference immediately before it, open it `with <other-ref>: `, spelling that reference as §A prints it — `check-doc-map.js` FAILs a prefix naming anything else (mantahostels#2647) — or word it to name more than one thing on its face: a plural, or two nouns coordinated.

### Repo-root contracts

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `CLAUDE.md` | CLAUDE.md | `source-of-truth` | Direct | — |

### Domain decisions

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `GLOSSARY.md` | The domain glossary: one entry per term the repo's machinery and its rules use, each with its _Avoid_ list | `source-of-truth` | Direct, or through the `domain-modeling` skill | — |
| `docs/adr/*` | Every file under `docs/adr/` — architecture decision records | `source-of-truth` | Direct | — |
| `docs/practice/*` | Every file under `docs/practice/` — one practice note per craft, `docs/practice/<craft>.md`, holding what leading professionals of that craft do and use, under one `Researched:` date (#2258) | `source-of-truth` | Direct. A refresh rewrites the note in place, git history the record | — |

### Governance & process docs

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `.claude/output-styles/core-voice.md` | Core voice — output style | `source-of-truth` | Direct | `docs/working-contract.md` (§Working patterns: the reader model it took over) |
| `docs/always-loaded-passes.json` | The newest concision pass over the always-loaded pool. `scripts/check-always-loaded-pass.js` reads it on `npm run status` and reports when a pass is due — a calendar month on, or the pool's headroom under its 220 B margin. | `source-of-truth` | Replaced by the session that ran the pass, in the commit carrying the cuts | `scripts/check-always-loaded-pass.js` (the checker that reads it) · `.claude/skills/concision-pass/SKILL.md` (§6: which writes it) |
| `docs/called-cards.md` | Called cards | `source-of-truth` | Direct, by any session. A row is added only for a card the founder has called, never to unblock a session; removed once its card is done or set down (mantahostels#3483) | `scripts/guard-issue-phase-scope.js` (the hook that reads it) · `docs/reference-roadmap.html` (which supplies each card's phase) |
| `docs/clobber-reviewed.json` | This repo's settled issue-body clobber SUSPECTs, keyed by the check's `#N<TAB><edit time>` identity, each value naming what the deliberate rewrite did (#1700, #1877). `scripts/check-clobbered-bodies.js`'s header owns the shape. | `source-of-truth` | Direct, one entry per SUSPECT judged a rewrite from the issue's `userContentEdits`; a race is restored on the issue instead | `scripts/check-clobbered-bodies.js` (the checker that reads it) |
| `docs/code-standards-base.md` | The code-standards base the plugin ships and every repo's review reads in place (#947): the rules true in any repo, routed by code kind, with stack clauses keyed to a tool's tell and house clauses on by default. Its line pins resolve at the plugin root, anchored in `scripts/code-standards-base-anchors.json`. | `source-of-truth` | Direct | — |
| `docs/code-standards.md` | The core's local standards file, read beside `code-standards-base.md` (#967): its changes to the base (exception rows only), route rows sending its Python tests to test and its other Python to program, and the core's own sections. **§W is the live tooling matrix** (mantahostels#1537), the check a candidate rule passes before it is written: which checker sees which surface, which CI gate runs each checker and whether it refuses, and what is not measured by decision; the pre-commit floor is base §0's. Then Smells not raised and Out of scope. Never shipped: an adopter keeps its own. | `source-of-truth` | Direct | — |
| `docs/doc-map-admissions.json` | The admission record mantahostels#2884 asked for and mantahostels#3225 gated: one row per §B entry admitted since 6 September 2026, naming the settling issue, what the founder answered and the permalink of the comment recording it. Rows are never deleted, so a later-removed id keeps its record. | `source-of-truth` | Direct, in the same commit that adds the `### B<n>` entry — never after it; `check-doc-map.js` assertion 29 FAILs a birth with no row | — |
| `docs/doc-map-classes.json` | Doc map classes — data file | `source-of-truth` | Direct, or `node scripts/register-doc.js <path> --class <token> --section <name>` for a new key, which claims `A:<path>` first and refuses a `--section` §A does not already carry unless `--new-section` is given | `mantahostels#1808` · `mantahostels#1848` |
| `docs/doc-map-high-water.json` | The high-water mark: the highest §B id ever removed. A new id sits above it, so a removed id is never reused (mantahostels#892); `check-doc-map.js` assertions 12 and 13. | `source-of-truth` | Direct, in the commit that removes a `### B<n>` entry above it; never lowered | — |
| `docs/doc-map-restatements.json` | This file, not the entry, is where a reader finds which part of each file holds the copy (mantahostels#1474); a `reference-roadmap.html` path's `locator` is the bare card id, ruled at mantahostels#1573 and set out in §B's preamble. | `source-of-truth` | Direct, alongside the §B entry it serves | — |
| `docs/doc-map-retired-vocabulary.json` | Doc map retired vocabulary — data file | `source-of-truth` | Direct, alongside the §B entry it serves | — |
| `docs/doc-map-superseded.json` | Doc map superseded — data file | `source-of-truth` | Direct, alongside the §B entry it serves | — |
| `docs/doc-map.md` | Doc map | `source-of-truth` | Direct; bump the stamp's version and date on every edit — the hand-written regions only. A §A row rendered by `npm run gen:doc-map-section-a` needs no bump: the generator never touches the stamp, and mantahostels#845 left the version hand-set because the MAJOR/MINOR split cannot be read off the file (mantahostels#2313). | — |
| `docs/effort-guide.md` | Effort guide | `source-of-truth` | Direct | `mantahostels:research/claude-model-lineup-2026-08.md` · `mantahostels:research/max-plan-limits-and-ultrareview.md` · `mantahostels:research/opus-effort-lever-status.md` · `mantahostels:research/opusplan-plan-mode-gate.md` |
| `docs/environment.md` | Environment | `source-of-truth` | Direct; re-verify against the live system, never from recall | — |
| `docs/machinery-superseded.json` | §B registers Manta's world and earns these no entry (mantahostels#1440); the checker's header owns the shape, including the rule that a share carries both the percent and the decimal-fraction spelling | `source-of-truth` | Direct, alongside the figure it retires; the checker exempts it from its own scan | — |
| `docs/new-repo.md` | What /new-repo does, what the founder approves and gets, and what to do when a run stops part-way (#713, #724) | `source-of-truth` | Direct | `.claude/skills/new-repo/scripts/new-repo.js` (the script whose resume form and exit codes it quotes) |
| `docs/pool-admission-ledger.json` | The admission ledger (#1943): one entry per top-level rule in the always-loaded pool, keyed by file and headline, giving its removal claim and route — no-trigger, trigger with the ticket whose guard will print it, or pre-first-tool-call. `scripts/check-context-budget.js --against HEAD` refuses a commit adding a pool rule with no entry. | `source-of-truth` | Direct, in the same commit that adds or rewords the pool rule; a headline reworded moves its entry | `scripts/check-context-budget.js` (the gate that reads it) |
| `docs/working-contract.md` | How work is sequenced and approved; style and self-containment live in `.claude/output-styles/core-voice.md` (mantahostels#1504, mantahostels#1618) | `source-of-truth` | Direct | — |

### The roadmap triple

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `docs/reference-roadmap.html` | Reference roadmap — HTML document | `source-of-truth` | **`roadmap-edit` skill only.** Never hand-edit | — |
| `docs/roadmap-digest.md` | Roadmap digest | `derived` | `gen-roadmap-digest.js`, committed with the HTML. `check-digest-version.js` fails on a drifted version line, `check-digest-render.js` on bytes differing from a fresh render — of the HTML, the digest and the generator as the index holds them, never the worktree. A generator that will not run refuses too, and so does a staged deletion of any of the three (mantahostels#2894); only a path that was never in the index makes the gate skip. `roadmap-digest.yml` runs it on the sweeps as well (mantahostels#2895) | `reference-roadmap.html` |

### Research runs

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `docs/research/adopter-suite-cost.md` | How long fantasy-books' and design-vault's suites take and what share is boundary cost a core would remove (#2238): fantasy-books 810 s serial, program-spawn share 0.70, measured cut 23-48%; design-vault 1,061 s, spawn share 0.13, Chromium 0.78, cut 7-11%. Splits one program call into node start, own git, logic. Holds the node:test and Python instrument. | `free-edit` | Direct | — |
| `docs/research/always-loaded-shed-candidates.md` | The standing register of always-loaded shed candidates — Register I (C1–C11), II (R1–R21) and III (G1–G7), all spent but G7 — with each tranche's behavioural trigger audit, fragment and span bytes, and the shed that landed. Route (f) cut 50–71% of a cluster where route (e) landed 38.8%. `guard-push-rules.sh`'s **220** fires against `guard-pull-form.sh`'s **17** (12.9:1) bear out the >5:1 push-over-pull prediction. | `source-of-truth` | Replaced whole when the shed ledger is re-measured; read by context-budget-pathspecs.js and count-guard-fires.js | `docs/doc-map.md` (§Capture and placement §3: the routes it classifies against; §5: the ledger of prior sheds it must not re-propose) · `mantahostels:docs/research/context-reread-composition.md` (mantahostels#1081, what a pool KB costs) · `scripts/check-context-budget.js` · `mantahostels#1225` (the ticket that takes these cuts) · `mantahostels#2140` (the guard-fire counts it reads off) |
| `docs/research/core-movable-logic.md` | How much logic in the 20 costliest test files and 10 bash guards could move to an in-process core behind ports, and what it saves (#2205): 3,586 of 3,706 cases movable, 102-274 s at measured prices, guard-parse.sh the main unit to port. | `free-edit` | Direct | — |
| `docs/research/guard-port-cut-band.md` | How much of the bash-guard test time a Node core removes (#2202): guard is 74-99% of 11 measured files' time, predicted class cut 72-87% (wide 59-96%), about 280-340 s of CI Vitest; read a port on its own files' guard share, never CI wall. Holds the measuring instrument. | `free-edit` | Direct | — |
| `docs/research/hexagonal-testing.md` | What published research and practice say about ports and adapters, functional core / imperative shell and the test-shape models (#2192): no measured run-time or defect effect, no sourced end-to-end count, and a contract test for every owned fake; plus the gh stub drift (#2220). | `free-edit` | Direct | — |
| `docs/research/injected-tracker-docs-shed-candidates.md` | Headline: **11,589 B available, 20% of the 57,652 B surface**, and **only three of the twelve candidates are route (e)**, route (a) being closed by the vendored hash lock. **Subset injection returns no headroom at all**, a scope change being byte-neutral […] | `source-of-truth` | Replaced whole when the shed ledger is re-measured; read by context-budget-pathspecs.js and count-guard-fires.js | `docs/research/always-loaded-shed-candidates.md` (mantahostels#1222, the pool's equivalent list and the shape this follows) · `docs/doc-map.md` (§Capture and placement §3: the routes it classifies against; §4: the injection cap and its named residual) · `mantahostels:docs/research/tracker-index-prototype.md` (mantahostels#1118, the cheaper alternative it defers to) · `scripts/inject-tracker-docs.sh` (the subject) · `scripts/check-context-budget.js` |
| `docs/research/instruction-surface-census-2026-10-15.md` | The census `scripts/check-instruction-surface.js` reads (#1604): 49 always-loaded rules (39 printed by nothing at need), 125 hook entries, 66 guards each fed a triggering payload, 40 skill directories. Its first section lists the guard defects the measurement found, filed at #1717. | `source-of-truth` | Replaced whole by the next census; anchored by scripts/instruction-surface-anchors.json | — |
| `docs/research/primitives-heresies-exemplars.md` | #2198's survey of published codebases and factories that declare primitives (Dodds' term: the one way to do a recurring job, with an exemplar) and police heresies (Yegge's term: agent-spread wrong patterns), ranked by form: lint whose message names the primitive, with a ratchet; a checked primitives map that risk-labels each PR; scheduled agent sweeps; named heresies in priming; LLM review criteria. ⚠ No study isolates agents copying a bad pattern from neighbouring files. | `free-edit` | Direct | — |
| `docs/research/repeated-review-runs.md` | Repeated review runs — research run | `free-edit` | Direct | — |
| `docs/research/startup-load-before-after-test.md` | Design of the one before/after rule-following test of a cut startup load: tasks, arms, score, runs per arm, cost (#1940) | `source-of-truth` | Rewritten in place while the before/after test it specifies runs (#1996) | — |
| `docs/research/test-cost-practices.md` | Which test-cost practices precedent and published guidance support, and the efficacy fault each caused (#1792): build once with fresh copies, the in-process seam with one real-boundary case, one pass with a byte-identical check, timing reported never refused. | `free-edit` | Direct | — |
| `docs/research/test-wait.md` | Where test wait falls in workflow-core and mantahostels, and how much is boundary cost (#2194): push-selected runs and queue wait dominate locally, CI Vitest is 82% of the job and bounded by total file-seconds, bash-guard tests 26% of CI file-seconds. | `free-edit` | Direct | — |

### Skills & settings

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `.claude/agents/code-reviewer.md` | The code-review axis agent: pins both review axes to Opus 5.5 at high effort through its frontmatter (#363) | `source-of-truth` | Direct | — |
| `.claude/guard-registry-anchors.json` | Guard registry anchors — data file | `source-of-truth` | Direct | — |
| `.claude/plugin-context-cost.json` | Plugin context cost — data file | `source-of-truth` | Direct | — |
| `.claude/settings.json` | Settings — data file | `free-edit` | Direct | — |
| `.claude/skills/THIRD-PARTY-NOTICES.md` | Licence notices for the vendored skills | `source-of-truth` | Upstream's licence text, verbatim, one `## <source>` section per `skills-lock.json` source, its `Skills:` line matching the lock; `scripts/check-vendored-skills.js` and the release render refuse a mismatch (#1939) | — |
| `.claude/skills/animate` | Animate — skill | `source-of-truth` | Vendored from `emilkowalski/skills` | `mantahostels:docs/inspiration/catalogue.json` (hard rule 6 reads the entries' motion blocks once step 2 has named a purpose) · `~/design-vault/data/gallery.json` (hard rule 6's source where a repo has no catalogue) |
| `.claude/skills/architecture-scan/SKILL.md` | Architecture scan — skill | `source-of-truth` | Direct | `.agents/skills/improve-codebase-architecture/SKILL.md` (the vendored scan it wraps) · `scripts/report-arch-scan-due.js` (§1 and §Close: the counter it reads) · `docs/data/arch-scan-runs.jsonl` (§8 and §Close: which it appends) · #1348 (the spec it shipped under) |
| `.claude/skills/ask-matt` | Ask matt — skill | `source-of-truth` | Vendored from `mattpocock/skills` — re-vendor rather than hand-edit; local changes are lost on update | — |
| `.claude/skills/browser-ladder/SKILL.md` | Browser ladder — skill | `source-of-truth` | Direct | `scripts/browse.py` (rung 2) · `docs/agents/rules/founder-handover.txt` (the auto-mode refusal rule and the acts the founder does by hand) · `docs/working-contract.md` (the ban on paid research and data services) · #1063 (the spec it shipped under) · #1092 (the spec behind its climbing rules and send hand-over) |
| `.claude/skills/burn-mode/SKILL.md` | Burn mode — skill | `source-of-truth` | Direct | `scripts/burn-mode.sh` (the toggle it wraps) · `docs/effort-guide.md` (§Burn mode, the rule it drives) |
| `.claude/skills/capture-drain/SKILL.md` | Capture drain — skill | `source-of-truth` | Direct | `docs/doc-map.md` (§Capture and placement: the rule it applies) · `scripts/capture-drain.js` (the queue and the mark) |
| `.claude/skills/card-close/SKILL.md` | Card close — skill | `source-of-truth` | Direct | `.claude/skills/roadmap-edit/SKILL.md` (the loop it delegates to) · `docs/agents/issue-tracker.md` (title convention) |
| `.claude/skills/code-review` | Code review — skill | `source-of-truth` | Vendored (as above) | — |
| `.claude/skills/codebase-design` | Codebase design — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/concision-pass/SKILL.md` | Concision pass — skill | `source-of-truth` | Direct | `working-contract.md` (the standard it enforces) |
| `.claude/skills/concision-pass/scripts/check-facts.js` | Check facts — skill | `source-of-truth` | Direct | — |
| `.claude/skills/concision-pass/scripts/check-facts.test.ts` | Check facts.test — skill | `source-of-truth` | Direct; extend as above | `check-facts.js` |
| `.claude/skills/concision-pass/scripts/concision-scope.js` | Concision scope — skill | `source-of-truth` | Direct | `SKILL.md` (the floor it compares against) |
| `.claude/skills/concision-pass/scripts/concision-scope.test.ts` | Concision scope.test — skill | `source-of-truth` | Direct; extend as above | `concision-scope.js` |
| `.claude/skills/concision-pass/scripts/mark-pass.js` | Mark pass — skill | `source-of-truth` | Direct | — |
| `.claude/skills/concision-pass/scripts/mark-pass.test.ts` | Mark pass.test — skill | `source-of-truth` | Direct; extend as above | — |
| `.claude/skills/concision-pass/scripts/tenure.js` | Tenure — skill | `source-of-truth` | Direct | `SKILL.md` (the reading it hands back) |
| `.claude/skills/concision-pass/scripts/tenure.test.ts` | Tenure.test — skill | `source-of-truth` | Direct; extend when a new failure mode is found | `tenure.js` |
| `.claude/skills/design-mode/SKILL.md` | Design mode — skill | `source-of-truth` | Direct | `scripts/design-mode.sh` (the toggle it wraps) · `~/.claude/statusline.sh` (outside the repo; reads the same boolean — see `claude-user-settings.md`) |
| `.claude/skills/diagnosing-bugs` | Diagnosing bugs — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/domain-modeling` | Domain modeling — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/grill-me` | Grill me — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/grill-with-docs` | Grill with docs — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/grilling` | Grilling — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/handoff` | Handoff — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/implement` | Implement — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/improve-codebase-architecture` | Improve codebase architecture — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/manual-sync/SKILL.md` | Manual sync — skill | `source-of-truth` | Direct | — |
| `.claude/skills/new-repo/SKILL.md` | New repo — skill | `source-of-truth` | Direct | — |
| `.claude/skills/new-repo/scripts/new-repo-page.test.ts` | New repo page.test — skill | `source-of-truth` | Direct; extend as above | — |
| `.claude/skills/new-repo/scripts/new-repo.js` | New repo — skill | `source-of-truth` | Direct | — |
| `.claude/skills/new-repo/scripts/new-repo.test.ts` | New repo.test — skill | `source-of-truth` | Direct; extend as above | — |
| `.claude/skills/pick-next/SKILL.md` | Pick next — skill | `source-of-truth` | Direct | `scripts/pick-next.js` (the shortlist it wraps) · `docs/agents/issue-tracker.md` (the frontier rules it inherits) · `references/measured-figures.md` (the figures its steps cite) |
| `.claude/skills/pick-next/references/measured-figures.md` | Measured figures — skill | `source-of-truth` | Direct — a re-measurement supersedes the paragraph it lands in, condition and all; never quote a figure without it | `scripts/pick-next.js` · `scripts/measure-bundle-cost.js` (mantahostels#1094's measurement — the two the figures are read off) |
| `.claude/skills/pressure-test/SKILL.md` | Pressure test — skill | `source-of-truth` | Direct | `.agents/skills/writing-for-agents/SKILL.md` (the prose levers) · `CLAUDE.md` (§Subagent dispatch: the stall fallback) |
| `.claude/skills/prototype` | Prototype — skill | `source-of-truth` | Vendored | `mantahostels:docs/inspiration/catalogue.json` (`UI.md` §2 reads the surface's group before drafting variants) |
| `.claude/skills/rescue-sessions/SKILL.md` | Rescue sessions — skill | `source-of-truth` | Direct | `scripts/rescue-sessions.js` (the engine it drives — list, snapshot, stop, probe, takeover) · `scripts/dispatch-sessions.sh` (how the successor sessions are launched) |
| `.claude/skills/rescue-sessions/references/RESUMPTION.md` | RESUMPTION.md — skill | `source-of-truth` | Direct | — |
| `.claude/skills/research` | Research — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/retire-to-roadmap/SKILL.md` | Retire to roadmap — skill | `source-of-truth` | Direct | `roadmap-edit/SKILL.md` (the loop it defers to) · `docs/called-cards.md` (which cards are open for work) |
| `.claude/skills/retro` | Retro — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/retro-sweep/SKILL.md` | Retro sweep — skill | `source-of-truth` | Direct | `.agents/skills/retro/SKILL.md` (the per-session retro it wraps) · `scripts/pick-retro-sessions.js` (the picker) · `scripts/retro-transcript.js` (the log reducer) · #948 (the spec it carries out) |
| `.claude/skills/retro-sweep/brief.md` | The per-session subagent brief retro-sweep fills and dispatches: retro as written, this machine's substitutions, the coverage pass and the artefact order. | `source-of-truth` | Direct | `.claude/skills/retro-sweep/SKILL.md` (§4: which fills it) |
| `.claude/skills/roadmap-edit/FIELDS.md` | FIELDS.md — skill | `source-of-truth` | Direct | `reference-roadmap.html` (the shape it describes) |
| `.claude/skills/roadmap-edit/SKILL.md` | Roadmap edit — skill | `source-of-truth` | Direct | `FIELDS.md` (the schema it defers to) |
| `.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js` | Gen roadmap digest — skill | `source-of-truth` | Direct | — |
| `.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.test.ts` | Gen roadmap digest.test — skill | `source-of-truth` | Direct; extend as above | `gen-roadmap-digest.js` · `docs/reference-roadmap.html` · `docs/roadmap-digest.md` (the smoke case) |
| `.claude/skills/roadmap-edit/scripts/roadmap-fixture.ts` | Roadmap fixture — skill | `source-of-truth` | Direct; mirror any change to the HTML's `ITEMS`/`AREAS`/`PHASES` shape | — |
| `.claude/skills/roadmap-edit/scripts/validate.js` | Validate — skill | `source-of-truth` | Direct | — |
| `.claude/skills/roadmap-edit/scripts/validate.test.ts` | Validate.test — skill | `source-of-truth` | Direct; extend when a new failure mode is found | `validate.js` · `reference-roadmap.html` (smoke case) |
| `.claude/skills/setup-matt-pocock-skills` | Setup matt pocock skills — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/tdd` | Tdd — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/teach` | Teach — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/to-questionnaire` | To questionnaire — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/to-spec` | To spec — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/to-tickets` | To tickets — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/triage` | Triage — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/wait-what/SKILL.md` | Wait what — skill | `source-of-truth` | Direct. **De-vendored at mantahostels#1502**: the body is repo-owned now, so a pack refresh must not re-link it. **The upstream copy is gone (mantahostels#1757)**: `.agents/skills/wait-what/` and its `skills-lock.json` entry were both deleted, the entry being what a pack refresh would have re-fetched from | `.claude/output-styles/core-voice.md` (§Comprehension: the no-bare-references rule it enforces on demand) |
| `.claude/skills/wayfinder` | Wayfinder — skill | `source-of-truth` | Vendored | — |
| `.claude/skills/wfc-delivery/*` | The delivery mod (#849, #854, #855, #856): a thin loop that appends a report this session's own start produced, a release request against a file it holds, or a sweep verdict that changed mid-session, into the live session; README states the tested version, the floor and the off-switch | `source-of-truth` | Direct | `scripts/deliver-to-session.js` (the script it runs each changed tick) |
| `.claude/skills/wfc-liveness/*` | The liveness mod (#863, #865, #866): names a stalled subagent in the status line as a fact and lists every subagent in a pane on /liveness; README states the tested version, the floor, how to open the pane and the off-switch | `source-of-truth` | Direct | — |
| `.claude/skills/writing-for-agents` | Writing for agents — skill | `source-of-truth` | Vendored | — |
| `.claude/workflow-core.json` | The adopter's config — contract, modules, commands | `source-of-truth` | Direct | — |
| `docs/claude-user-settings.md` | Claude user settings | `derived` the JSON and file blocks only; the prose around them is edited directly, to describe the keys as the live file uses them (#358) and to hold the procedures the browser guard's refusals point to (#2041) | **Re-copy only** for the JSON and file blocks, from `~/.claude/settings.json`, `~/.claude/statusline.sh`, `~/.claude/hooks/browser-profile-guard.sh`, `~/.claude/hooks/practice-guard.sh`, `~/.claude/CLAUDE.md` and `~/.claude/practice-crafts.md`, and re-date it. Never edit a block here to change behaviour — edit the live file, then re-copy. No **CI** guard is possible — the source is outside the repo, so a runner could only skip. Guarded **locally** instead by `scripts/check-user-settings-drift.js` (semantic JSON compare, text compare for the file blocks; warn-only in pre-commit, hard via `npm run check:settings`; SKIPs where the source is absent) | `~/.claude/settings.json` (outside the repo) · `~/.claude/statusline.sh` (outside the repo) · `~/.claude/hooks/browser-profile-guard.sh` (outside the repo) · `~/.claude/hooks/practice-guard.sh` (outside the repo) · `~/.claude/CLAUDE.md` (outside the repo) · `~/.claude/practice-crafts.md` (outside the repo) |

### Agent-skill configuration

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `docs/agents/adopter-upgrade.md` | Adopter upgrade — agent guide | `source-of-truth` | Direct | — |
| `docs/agents/autonomy-ceiling.md` | Autonomy ceiling — agent guide | `source-of-truth` | Direct, and only on a founder ruling — the line is not an agent's to move | `CLAUDE.md` (§Conventions: the write-scope rule that bars R3, and the *driven session* the definition serves) |
| `docs/agents/blind-dispatch.md` | Blind dispatch — agent guide | `source-of-truth` | Direct | — |
| `docs/agents/dependabot.md` | Dependabot — agent guide | `source-of-truth` | Direct | — |
| `docs/agents/domain.md` | Domain — agent guide | `source-of-truth` | Direct | — |
| `docs/agents/guard-authoring.md` | Settled at mantahostels#1239, which refused a generator; surface 7, the fire-needles entry, added at mantahostels#1418 | `source-of-truth` | Direct | `scripts/hook-registrations.test.ts` (the wiring evidence it quotes) · `scripts/guard-fire-needles.json` (surface 7) · `scripts/check-guard-registry.js` (the gate on surface 8) · `docs/effort-guide.md` (a rule region outside the always-loaded pool) |
| `docs/agents/guard-registry.md` | The enforcement record of rules a guard prints at need, kept out of the always-loaded pool (#1942): each rule's marker, guard path and citations, in a guard-registry region `scripts/check-guard-registry.js` reads. A new guard's rule sentence lands here by default. | `source-of-truth` | Direct | `scripts/check-guard-registry.js` (the checker that reads its region) |
| `docs/agents/helper-surface.md` | Helper surface — agent guide | `source-of-truth` | Direct | `scripts/lib/resolve-core.js` (the resolver whose CI variable the recipe sets) · `scripts/lib/helper-surface-ci.test.ts` (runs the recipe steps as written) |
| `docs/agents/issue-tracker.md` | Issue tracker — agent guide | `source-of-truth` | Direct | `reference-roadmap.html` (card state) · `its close, placement, claiming and labelling rules are backstopped by seven report-only checks, none of which may write to a tracked file` · `scripts/check-issue-card-drift.js` · `check-ticket-criteria.js` · `check-issue-citations.js` · `check-issue-orphans.js` · `check-issue-labels.js` · `check-stale-claims.js` · `check-clobbered-bodies.js` |
| `docs/agents/last30days.md` | Last30days — agent guide | `source-of-truth` | Direct | — |
| `docs/agents/mutation-testing.md` | Mutation testing — agent guide | `source-of-truth` | Direct | `mantahostels:AGENTS.md` (§Supervision priors: the loop it qualifies) |
| `docs/agents/partial-commit.md` | Partial commit — agent guide | `source-of-truth` | Direct | `docs/agents/rules/commit-pathspec.txt` (the rule it extends) · `scripts/lib/arbiter-locks.js` (the `park()` it clears as the only working-tree restorer) |
| `docs/agents/rules/*` | Only the HAND-WRITTEN files under `docs/agents/rules/` — `README.md`, and every fragment with no row of its own | `source-of-truth` | Direct, and ONLY for a file with no row of its own: a hand edit to a generated fragment is overwritten silently by `npm run gen:rule-fragments` (mantahostels#2586). However it is authored, a fragment reaches a session by one of two routes, or `scripts/check-guard-registry.js` FAILs. Printed: it lands alongside the accessor call in a wired emitter (a guard, a hook, a workflow, or a lib one of them reaches), or UNPRINTED-RULE. Session-fetched: `docs/agents/rules/manifest.json` lists it and a wired command index names it, or UNINDEXED-RULE (mantahostels#2496). A `rule:<id>` trigger naming no fragment FAILs on ORPHAN-TRIGGER, and a manifest id naming none on MANIFEST-ORPHAN. **Nothing asserts that a fragment keeps a trigger line** (mantahostels#2006, which retired the ORPHAN-FRAGMENT warn), so never keep one believing a gate requires it | `mantahostels#1644` (the ticket that built the store) · `mantahostels#1641` (the spec relocating the guard-backed rules) · `scripts/lib/rule-text.js` · `scripts/lib/rule-text.sh` |
| `docs/agents/rules/card-close-route.txt` | Card close route — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/citation-inferred-number.txt` | Citation inferred number — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/citation-number-first.txt` | Citation number first — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/close-outstanding-line.txt` | Close outstanding line — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/commit-closes-keyword.txt` | Commit closes keyword — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/create-command-shape.txt` | Create command shape — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/triage-labels.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/decisions-search-first.txt` | Decisions search first — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/dependency-edge-false-success.txt` | Dependency edge false success — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/founder-deliverable.txt` | Founder deliverable — agent rule: how a founder-facing item is filed at once, under which takes: label, and the takes:human body template ending in a Close-when line (#983, spec #958) | `source-of-truth` | Direct | `scripts/guard-issue-create-label.js` (refuses a takes:human body without the Close-when line, printing this) · `scripts/file-issue.js` (prints this whenever it applies takes:human) · `scripts/guard-session-ceiling.js` (prints this in full on a ceiling band's first block, a pointer to it on every repeat) · `scripts/guard-inventory.js` (prints this under every refused founder inventory) |
| `docs/agents/rules/gh-cli-limits.txt` | Gh cli limits — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/gh-job-dir-unreadable.txt` | Gh job dir unreadable — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/issue-body-raw-write.txt` | Issue body raw write — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/issue-body-success-signal.txt` | Issue body success signal — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/issue-claim-scope.txt` | Issue claim scope — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/issue-created-assigned.txt` | Issue created assigned — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/issue-parent-unplaced.txt` | Issue parent unplaced — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/issue-title-card-id.txt` | Issue title card id — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/kind-label-vocabulary.txt` | Kind label vocabulary — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/triage-labels.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/manifest.json` | The rule store's index — every generated fragment, its id and the anchored region it came from | `generated-only` | `npm run gen:rule-fragments`, which re-derives it from the generator's own `TRIGGERS` table and each anchor's source path. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/research-artefact-scratch.txt` | Research artefact scratch — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/roadmap-gating.txt` | Roadmap gating — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/spec-only-contract.txt` | Spec only contract — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/takes-label-nuances.txt` | Takes label nuances — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/triage-labels.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/takes-value-vocabulary.txt` | Takes value vocabulary — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/triage-labels.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/test-reads-visible.txt` | Test reads visible — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/code-standards-base.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/test-run-cost.txt` | Test run cost — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/code-standards-base.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/test-time-seam.txt` | Test time seam — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/code-standards-base.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/ticket-criteria-unticked.txt` | Ticket criteria unticked — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/waiting-external-vocabulary.txt` | Waiting external vocabulary — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/triage-labels.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/rules/wayfinder-ops-shapes.txt` | Wayfinder ops shapes — agent rule | `generated-only` | `npm run gen:rule-fragments`, re-rendered from the anchored region in `docs/agents/issue-tracker.md`. `--check` gates it in .husky/pre-commit. | — |
| `docs/agents/tool-output.md` | Tool output — agent guide | `source-of-truth` | Direct | `scripts/lib/wide-read.js` (the warn-only guard it registers) · `scripts/lib/echo-call.js` (the sibling PreToolUse Bash\|Read guard it registers, mantahostels#2615) · `docs/agents/guard-authoring.md` (the eight surfaces that hook satisfies) · `scripts/lib/image-budget.js` (the PostToolUse Read core it registers, #1784) |
| `docs/agents/tracker-fields.md` | Tracker fields — agent guide | `source-of-truth` | Direct; add a row whenever a skill starts writing a new field, and name the consumer | `docs/agents/issue-tracker.md` (the rule, which points here) |
| `docs/agents/triage-labels.md` | Triage labels — agent guide | `source-of-truth` | Direct | — |
| `docs/agents/verification.md` | Verification — agent guide | `source-of-truth` | Direct | `mutation-testing.md` (the craft its tested-guarantee branch reaches) |

### Non-prose

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `docs/data/session-cost-table.json` | Per-session cost table the capped launch reads (#371, #372): mean and 41 quantiles of what a dispatched Opus 5.5 or Sonnet 5 session spends, subagents included, advisor not; the tail's mean remainder past the second-highest quantile; and the share of spend landed by each hour mark (#2925). The mean times points-per-dollar is the per-session bar figure; the quantiles and tail give a running session's expected remainder; the landed shares count only what lands before a bar resets. | `generated-only` | `node scripts/measure-session-cost.js --write`, re-derived from the dispatch ledger and every seat's transcripts; never hand-edited, never run at launch. | — |
| `docs/test-read-edges.json` | The read-graph vitest cannot see: a tracked file mapped to the test files reaching it through readFileSync rather than an import. `--changed` unions these in, so a doc change selects the tests asserting over it instead of the zero it selected at mantahostels#2031. | `generated-only` | `npm run gen:test-read-edges`, re-derived from the tracked test corpus; never hand-edited. `--check` gates it in .husky/pre-commit. | — |
| `hooks/hooks.json` | The plugin's hook manifest: self-plugin/hooks/hooks.json's hooks, less the self-plugin's marker writer, with every scripts/ path spelled through the plugin root, quoted in shell form and bare in exec form. What a --plugin-dir load of this repo registers; a release renders its own copy. | `generated-only` | `node scripts/generate-plugin-hooks.js`, re-derived from self-plugin/hooks/hooks.json; never hand-edited. `--check` gates it in .husky/pre-commit. | — |
| `hooks/register.ts` | The plugin's entry module: imports each shipped mod's register and calls it with on, so an adopter loads both mods from the install cache. hooks/hooks.json names it under modules; the core itself never enables the plugin. | `source-of-truth` | Edited directly. A new mod is one import and one call here, plus the tests that list each mod; npm run typecheck's fifth pass checks it. | — |
| `hooks/tsconfig.json` | Type-checks hooks/register.ts, with the liveness mod's copy of the engine's declarations and its state contract. | `source-of-truth` | Edited directly; npm run typecheck runs it as its fifth pass. | — |
| `self-plugin/.claude-plugin/marketplace.json` | The wfc-self local marketplace: one plugin entry whose source is its own directory, so self-plugin/ loads in place as a plugin carrying only hooks/hooks.json. No plugin.json; this entry is the manifest. | `source-of-truth` | Edited directly. Each machine registers it once, by the setup step in docs/environment.md §13; never shipped to adopters. | — |
| `self-plugin/hooks/hooks.json` | The core's own hook registration: every hook workflow-core runs on itself, loaded in place as the wfc-self plugin at session start. .claude/settings.json keeps only the canary that refuses a session this did not load. | `source-of-truth` | Edited directly, an ordinary repo edit with no permission prompt; then re-render hooks/hooks.json with `node scripts/generate-plugin-hooks.js`, which also writes each PreToolUse hook's `onFailure`, `block` on exactly the deny-capable ones (#2670). check-registrations.js refuses a command registered here and in .claude/settings.json. | — |

### Evidence & data

| Path | Role | Class | Update route | Consumes |
|---|---|---|---|---|
| `docs/data/arch-scan-runs.jsonl` | One JSON line per architecture-scan event, oldest first (#1362, spec #1348): a seed line's since, a scan line's head, growth, threshold and hot files, a close line's yield and nextThreshold. | `source-of-truth` | Appended by the architecture-scan run or close step that produced it, committed by pathspec in that session | `scripts/report-arch-scan-due.js` (the counter that reads it) |
| `docs/data/close-rounds-2026-10-09/answered-close-rounds.json` | #1091's close-round baseline: the 82 close rounds the founder answered from 27 Sep to 9 Oct 2026 (session, time, each close question's gap, bands and escape line), 26 of them followed by a separation prompt. The week-one reading compares against its 26-of-82. | `source-of-truth` | Direct | — |
| `docs/data/close-rounds-2026-10-09/separation-prompts.json` | #1091's separation-prompt baseline: the 31 founder messages from 27 Sep to 9 Oct 2026 telling a session to check or research more before he picks, each with its text, session and whether it is his stock prompt (23) or not (8). #1091's week-one reporter is to test its stock-prompt regex against it. | `source-of-truth` | Direct | — |
| `docs/data/issue-title-search-2026-09-27/queries.json` | #500's similar-title sample: the 30 query titles, each with its known overlap and the issues the measured ranking showed, which `scripts/file-issue.test.ts` asserts `file-issue --check` reproduces. | `source-of-truth` | Direct | — |
| `docs/data/issue-title-search-2026-09-27/titles.json` | #500's similar-title sample: the 520 issue titles and their states, the frequencies and candidates `scripts/file-issue.test.ts` re-runs `file-issue --check` against, holding the threshold 6 and the top-3 cut in `scripts/lib/similar-titles.js`. | `source-of-truth` | Direct | — |
| `docs/data/lost-deny-census-2026-09-05/rates.md` | The lost-deny census's true deny rate per deny-capable guard, 5 Sep 2026 (mantahostels#3261): the table `scripts/lib/guard-deny-rates.js`'s RATES copies, kept so its test can diff the copy. | `source-of-truth` | Replaced whole when the census is re-run | `scripts/lib/guard-deny-rates.test.ts` (the test that reads it) |
| `docs/data/retro-runs.jsonl` | One JSON line per retro-sweep run, oldest first: mode, week, each pick with its signals, class counts and token cost, the issues filed and the low-value findings recorded unfiled (#964, spec #948). The weekly due reporter reads the newest weekly line's date; the fourth weekly line triggers the flip check. | `source-of-truth` | Appended by the retro-sweep run that produced it, committed by pathspec in that session | `.claude/skills/retro-sweep/SKILL.md` (§7: which writes it) |
| `docs/data/round-sendbacks-2026-10-14/rounds.json` | #1691's baseline for the under-researched-round refusal: #1682's 851 hand-classed round–reply pairs from 30 Sep to 14 Oct 2026, text-free, each with its tool calls since the founder's previous message. | `source-of-truth` | Direct | — |
| `docs/data/session-memory-2026-09-21/procs.csv.gz` | #333's session-memory sample — recompute with `python3 scripts/sample_session_memory.py analyse docs/data/session-memory-2026-09-21` | `source-of-truth` | Direct | — |
| `docs/data/session-memory-2026-09-21/samples.csv.gz` | #333's session-memory sample — recompute with `python3 scripts/sample_session_memory.py analyse docs/data/session-memory-2026-09-21` | `source-of-truth` | Direct | — |
| `docs/data/session-memory-2026-09-21/sessions.csv.gz` | #333's session-memory sample — recompute with `python3 scripts/sample_session_memory.py analyse docs/data/session-memory-2026-09-21` | `source-of-truth` | Direct | — |
| `docs/data/suite-file-timings-2026-10-24.csv` | The guard port programme's baseline suite timings (#2733, #2783): per-file seconds of one full suite run in 4 shards, read before and after the programme by `node scripts/suite-timings.js shares`. | `source-of-truth` | Never edited; a re-measure lands its own dated file | — |
| `docs/data/test-loss-baseline-2026-10-24/daily.csv` | #2821's test-loss base (#2823): per UTC day 10-19 Oct 2026, WFC main sessions' blocked and active hours and their share (median 19.9%). | `generated-only` | `python3 -I scripts/measure-test-loss/report.py --start 2026-10-10T04:10:00Z --end 2026-10-20T00:00:00Z --csv <path>`; never hand-edited, a re-measure lands its own dated file | — |

## Section B — load-bearing figure registry

Every entry: **Owner** (the one document allowed to change it) · **Inputs** (what it is derived from — change one and the figure is re-derived) · **Restated in** (every file carrying it) · **Supersedes** (the value it replaced, so a stale copy is recognisable on sight) · **Settled at** (the ticket that decided it). `Settled at` is never merely absent: `**Settled at #<n>**`, or `**Settled at:** none — <why>` where nothing decided it (assertion 10).

**An entry is a map, not a record.** It carries the live value, what a reader does with it, and what invalidates it. Derivation, measurement narrative, build history and prose another file owns go to the settling ticket. Enacted statutory text quoted as the operative test a claim turns on *is* the claim, and stays (mantahostels#1935).

- **What earns an entry: a load-bearing fact about the project's world** — product, business, catalogue, the law binding it. **A ruling about the repo's own machinery earns none**: it goes to its owner document, or to the settling ticket where that owner is always-loaded. **Ties default to no** (mantahostels#1728): unable to tell which subject a fact is, write no entry and record it on the issue you are working.
- **The write is not unilateral** (mantahostels#1728). Record the fact on the issue you are working and report that you did; it enters §B when the founder confirms it belongs.
- **The confirmation is written down before the entry is** (mantahostels#2884, mantahostels#3225). Post it on the settling issue first — his words verbatim, or the bare option letter where he answered a lettered round, never a paraphrase of what he meant. The commit adding a `### B<n>` id absent from HEAD adds a row to `docs/doc-map-admissions.json` — settling issue, his answer, that comment's permalink — or assertion 29 FAILs it. The checker reads the row's shape offline and never fetches the URL. A cap split is not an admission: its row carries `capSplit` and the id it came from.
- **The writer verifies; the handover does not.** An entry is written only by a session that has re-derived the value against the files and searched **closed** tracker issues for prior rulings on it. Re-read every entry a drafted entry cites at pasting time, not drafting time (mantahostels#767). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#805) -->

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
- **A restatement in §A is a path on `docs/doc-map-classes.json`**, one path object per key, its `locator` naming the field (`role`, `route`, `consumes`, `classQualifier`) and the key (mantahostels#2461). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#805) -->
- **A claim entry carries no number, so it carries a retired vocabulary** — the phrases a stale copy will use, the claim's own words appearing nowhere in its dependents — with the hits that are legitimate and a `Replacement:` line stating the surviving wording or naming its owner (mantahostels#204). Each phrase is stored as its `stem` beside the `literal` it retires; stems widen the match. In JSON, `\b` is a backspace: a word boundary is written `\\b`.
- **A claim entry is created when the claim is settled, not when it is applied**, marked known-incomplete for the propagating session to complete (mantahostels#26).
- **A superseded entry's needle is the whole phrase a value is named by, never the bare number** (mantahostels#2444), and a value no distinctive literal carries is listed `scanned: false`. A permanently-correct hit goes on the entry's allowlist, anchored by content and scoped to its needle: `{ "anchor": "…", "needle": "~22%" }`.
- **Writing about the warning sign raises one**: `scripts/check-doc-map-markers.js` reads the sign followed by a space and a word as a marker wherever it appears, so write it hyphenated or say "the sign". A date the marker states rather than confirms is tagged `(standing)`, and nothing ages it (mantahostels#1357).

None registered.

## Section C — question routes

### C1 · How do I start a new repo from workflow-core?
- **Read:** `docs/new-repo.md`.

## The propagation pass

Run this whenever a settled, load-bearing fact has to reach the corpus (mantahostels#25). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#805) -->

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
| `source-of-truth` via `roadmap-edit` (the roadmap HTML) | Invoke the skill in-session |
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

**Run the placement test in order; the destinations below are what it selects among** (mantahostels#1720). **Letters are frozen** — cited by letter across the repo — so a destination is added as a new letter, never renumbered (mantahostels#1245). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**Step 1 — is it a rule?** A rule constrains an action a session might otherwise take wrongly. A value to look up is not: that is (d).

**Step 2 — name the trigger.** The *nearest* observable event preceding the decision the rule binds — a tool call, or class of calls, expressible as a hook matcher plus a command test (mantahostels#3421). **Session start or prompt time — routes (a), (b), (c) — satisfies this step only where it is that nearest event**, as for a rule binding before the first tool call (mantahostels#2501 measured the miss otherwise). **No nameable trigger → (c), the always-loaded pool, whatever the arithmetic says** (mantahostels#1639). That is the pool's only entrance. `docs/working-contract.md`'s rules pass it: they bind before a reply is written, a moment no matcher reaches. **A pool rule whose decision is visible in the finished reply also takes a `Stop` check** — `scripts/guard-priced-options.js`'s shape. **Answering this step is gated wherever the answer lands bytes in the pool** — §5's trigger verdict (mantahostels#1788).

**Step 2 is answered per rule as the admission test (#1942).** Every top-level list item and bold-led paragraph an always-loaded file carries, outside fences and HTML comments, has an entry in `docs/pool-admission-ledger.json` (#2033, #2056): its removal claim, the wrong act a session takes without the rule, and its route — `no-trigger`, `trigger` with the `/implement` ticket whose guard will print it, or `pre-first-tool-call`. A rule a guard already prints at the moment it bites leaves the pool whole, its marker and citations going to `docs/agents/guard-registry.md`. A rule with a trigger but no guard printing it stays until one does. A rule that stays keeps one marker and the one path or issue `scripts/check-guard-registry.js` needs, and a residual clause only where it names an act. Where `.claude/workflow-core.json` sets `admissionGate`, `scripts/check-context-budget.js --against HEAD` refuses a commit adding a pool rule with no ledger entry.

**Step 3 — to choose, or only to be stopped?** Needed to choose correctly → (f). Needed only to refuse the wrong choice → (e). Both → both, from the same hook. **(f) misses the first occurrence**: injected `additionalContext` lands with the triggering call's result, after that call has run. **Where a first breach cannot be undone, take (e) and (f) from the same hook** (mantahostels#3421). **Behavioural, never topical** (mantahostels#886): read the mechanism's real output first.

**Step 4 — reach.** A trigger reaching only subagents puts the rule in the dispatch prompt. A skill body takes procedure alone (mantahostels#1757).

**Fail-open is disqualifying.** A surface that can silently reach nobody carries no binding rule — which bars `.claude/rules/` `paths:` frontmatter (mantahostels#1717: no hook in the path, documented silent fail-open) and skill bodies, and demotes (g).

**The test binds prospectively** — every new rule, every relocation (mantahostels#1787).

Destinations, in preference order:

- **a. The skill file that runs when the fact bites** (`.claude/skills/<skill>/SKILL.md`). Preferred wherever a fact only bites inside one skill's loop.
- **b. Text pasted into `scripts/inject-tracker-docs.sh`'s own header**, reaching its seven commands — `/wayfinder`, `/to-spec`, `/to-tickets`, `/implement`, `/triage`, `/card-close`, `/code-review`. For a fact that bites only in tracker work: a fact biting any session under-reaches here. `/code-review` takes the header's per-command block alone, so a rule meant for it goes in that arm. **Binding rules are placed here** (mantahostels#1916). **The budget is per command, not one number**: only the per-command blocks vary, so a rule placed in one arm spends none of another's margin. Read all seven live from `bash scripts/check-injector-margin.sh --tree`, against the harness's 10,000-character persistence threshold; `.husky/pre-commit` runs it on any commit staging the injector and refuses at the threshold (mantahostels#1915). §4's union cap binds every placement on top of that. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->
- **c. A pointer line in an always-loaded file** — a member of §4's pool. For a fact whose relevance a session cannot predict from the work in front of it. The line names the trap and points at the body; it never restates it.
- **d. Nothing at all.** For reference material a session finds when it goes looking — the §B class, and research linked from its issue. Legitimate where the fact is a value to look up rather than a trap to avoid.
- **e. A guard that reprints the text when it fires.** Bytes whose operative instruction a guard reproduces verbatim at the moment it bites are already retrieved, so the rule owes no shed for them. **The test is behavioural, not topical:** a session meeting only the guard's output must be able to act correctly without the cut bytes, so the session claiming this route reads the guard's actual output before cutting (mantahostels#886). **That test is a prediction, and §5 carries its verdict**: a tranche shedding on this route writes the claim into its ledger entry, and the tranche after it records whether the guard has since fired (mantahostels#1719). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->
- **f. A guard that injects the rule on the call it governs**, read with that call's result (step 3). The same `PreToolUse` hooks as (e), emitting `additionalContext` on the clean branch rather than a denial on the wrong one, through a core's `injectRules` decision, which `scripts/lib/guard-entry.js` latches and caps; rule bodies live in `docs/agents/rules/` (mantahostels#1717). **The billed unit is the SESSION, not the event** (mantahostels#2046). The kit latches per (rule, agent, session), so an id is delivered once in a top-level session's life however many events could carry it, and once again in each subagent it dispatches; what a session can be made to pay through one tool is the sum of the **distinct ids** every guard that tool wires can reach. The harness persists **10,000 characters per hook entry** ([docs/research/hook-payload-persistence.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-payload-persistence.md)), and `self-plugin/hooks/hooks.json` gives each guard one, so `RULE_CAP` (4,000 B, enforced inside `guard-entry.js`) is the whole of the truncation guarantee.
- **g. A pointer, in (b)'s header, to a named section of `docs/agents/issue-tracker.md` or `docs/agents/triage-labels.md`.** Neither document is pasted, so the bytes reach only the session that opens the section. ⚠ **Demoted: no new binding rule here** (mantahostels#1916). Its follow-through is the fail-open the test above disqualifies (mantahostels#1869). What belongs here is reference material, and rules whose miss a guard turns into a denial. **It does not reopen on a re-measurement**: only a mechanism that makes a session read the section rather than choose to puts it back in contention. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**Route (f) takes two caps, on independent axes** (mantahostels#1720). The first is **31,500 B per session per `PreToolUse` tool** — a **context-cost ceiling, never a truncation guarantee** — the largest live group, `Bash` at 31,079 B across 39 ids, rounded up past a 421 B slack band (#2023). `scripts/check-context-budget.js`'s **OVER-SESSION** assertion holds it (mantahostels#2004): it reads the live wiring, prints the per-tool figures on `npm run check:context`, and refuses a commit that raises an already-over-cap group.

The second is **a shared ratchet across all triggers** — the union of every reachable id across every tool, one fragment counted once however many guards or tools reach it — at **51,500 B**: 51,147 B across 69 ids measured on the session unit, rounded up past a 353 B slack band (#2060). **Neither cap's live headroom is stated here** (mantahostels#2272) — read both off `npm run check:context`. **The seed is never set below the measurement**, which would be §4's downward-only ratchet. **It is not retired**: the per-tool cap would permit its whole figure on each wired tool, and the union is what a session actually pays.

**Rule text a hook hands over after its call has run — on `PostToolUse`, `PostToolUseFailure` or `PostToolBatch` — is measured and uncapped** (#2144). `npm run check:context` prices it as it prices route (f), a latched id once a session and an unlatched one on every firing, and puts it on neither cap: both were seated on `PreToolUse` measurements, and no figure has been seated for this surface.

### 4. The always-loaded budget binds trigger lines, not facts (mantahostels#639, mantahostels#666)

No fact's *body* sits in an always-loaded file unless it must be read before *any* tool call; everything else takes a pointer to an on-demand body, and a new always-loaded body is priced in §5.

That residual is capped at **22.5 KB** — **a shared pool, not a per-member budget** — and **a tranche leaving the pool at or over that cap names the shed that pays for its bytes, in the same commit. Under cap no shed is owed; the tranche prices itself instead**, its §5 entry carrying the bytes added and the headroom it opened and closed (mantahostels#2036). **Headroom is spendable**: a shed owed below cap would make every addition net-zero-or-below — a downward-only ratchet (mantahostels#1220). The pool is not first-come, parallel sessions being the default here, and takes no per-file caps, which would freeze an arbitrary split between the members. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**What the pool covers is a test, not a list (mantahostels#1235, narrowed at mantahostels#1503): bytes in *every top-level* session's context before any work, that *this repo can delete*.** A subagent is not top-level; its own dispatch is priced where it is made. Three members pass it:

- **The files `.claude/workflow-core.json`'s `alwaysLoaded` declares** — here `CLAUDE.md`, `docs/working-contract.md` and `.claude/output-styles/core-voice.md` — in bytes on disk, read by `scripts/lib/always-loaded-pool.js`. The voice contract is **counted once**, as the active output style; it counts twice only while an always-loaded file also `@`-imports it (mantahostels#1503). A subagent therefore gets no voice, accepted at #1942 because it reports to its parent, never to the founder. **A background job is a top-level session, not a subagent.**
- **Own skill and command frontmatter `description` values**, **except where the startup listing never delivers the description**. A skill carrying `disable-model-invocation: true` is absent from the listing (mantahostels#1757); a `"name-only"`, `"user-invocable-only"` or `"off"` entry in `.claude/settings.json`'s `skillOverrides` drops the description alone (mantahostels#1786) — and being a settings key it reaches vendored skills too, whose frontmatter edits the next pull reverts. An unsilenced file with no `description` key is listed under its body's first non-blank line, heading marker stripped and cut at 100 characters, and is charged that line (#2054). **The surface grows by skill count, never by inflating an existing description**, so a pool contribution is the instrument and a per-description length limit is not (mantahostels#1235).
- **Agent definitions** (`.claude/agents/*.md`) — their **`name` and `description` only**, never their body.

**Two adjacent surfaces are measured and uncapped — excluded from the cap, never from governance** (mantahostels#1235).

- **Vendored skill descriptions**, in **delivered bytes**: a silenced description counts 0 B. They fail the *deletable* limb at byte granularity — symlinked from `.agents/skills/`, so one can be dropped whole while an edit to one is reverted by the next pull unless declared in `.agents/vendored-skill-edits.json` (mantahostels#1826). No cap exists because **no candidate number exists**: the set is an outside vendor's, and today's total is a snapshot of it (mantahostels#1260). **Adopting a new vendored skill names its description bytes — delivered, so 0 B where it lands silenced — in the adopting commit's message.** **Unenforced** (mantahostels#1260): nothing prompts an adopting session to look. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->
- **Plugins** — `claude plugin details <name>`'s Always-on token figure, quoted in the enabling commit message, read by `check-context-budget.js` from `.claude/plugin-context-cost.json`, which WARNs on an enabled plugin with no row rather than pricing it at zero (mantahostels#3116). No commit is refused on this surface: the plugin bytes live outside the repo.

**The vendor / wrap / write-locally ladder governs what adds to either** (mantahostels#1172, extended to plugins at mantahostels#2971). Reach for the cheapest primitive that can carry a repo-specific rule: (1) a script or hook; (2) a rule line in the document that already owns the surface; (3) a local skill, whose description enters the pool; (4) a wrap of a vendored skill, only where the upstream body is worth more than the wrapper costs; (5) vendoring, only where the skill needs no repo-specific rule in its body. **A plugin is rung 5 with one more condition**: the repo needs none of it edited and pays its whole always-on cost, a subset being a fork. <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**The injected tracker docs** fail the *every session* limb — `scripts/inject-tracker-docs.sh` fires on seven commands, in ~41% of sessions ([docs/research/tracker-injection-frequency.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md)) — and take **their own cap, 10,500 B**, over the union of every payload string the script can emit, whichever command takes it (mantahostels#1284, mantahostels#1817). The priced-options shape enters the union as its Core voice pointer; a host whose style is not Core voice gets the whole shape, bounded by the per-command assertion below (#2039). **This cap is not the limit that binds** (mantahostels#1901): the harness persists an injected payload inline only under 10,000 characters per command, which `scripts/inject-tracker-docs.test.ts` asserts and §3 route (b)'s margin script prints. The cap watches aggregate drift across strings several commands share, which no per-command assertion sees. **A span relocated out of `docs/agents/issue-tracker.md` or `docs/agents/triage-labels.md` into the header is not a shed**: the same bytes reach the same payload.

**Both values are ratchets against drift, not reopened on price alone (mantahostels#1220, mantahostels#1235).** The pool's **22,500 B** is the pool as measured on 18 October 2026, 20,334 B (#2034), rounded up past a band sized on the largest upward move between adjacent daily samples of its three files since 25 August, +1,813 B on 28 August — the gate being per-commit, the band has to survive the largest ordinary day (mantahostels#1662's method). The +9,941 B of 18 September is left out of the band: core-voice joining the pool was a scope change, which the scope trigger prices. The injection's **10,500 B** is the union as measured on 18 October 2026, 9,637 B (#2039), rounded up past the same method's band: +515 B on 6 September, the largest upward move between adjacent daily samples of the injector and its rule fragments from 29 August, the first day whose own tree the checker reads. **A KB in the pool is priced, and neither threshold is derived from the price**: a price is linear in bytes, so it has no knee. The currency in which a threshold *would* be coherent is **dilution** — what a KB costs is compliance with the rest — and it has no instrument (mantahostels#1159).

**Three things move the pool's value; a fourth reason is a new question, not a reopening.** **Cite a trigger by name, never by ordinal: striking one renumbers the rest** (mantahostels#1245). **(i) the scope trigger** — the pool's scope changing bumps or cuts the value by exactly the bytes folded in or out, so the change is always scope-neutral (mantahostels#1235, mantahostels#1284); **(ii) the price trigger** — the price moving by more than ~2×; **(iii) the unpayable-correction trigger** — a correction to a false rule that can name no shed (mantahostels#1221, below). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**Restated in:** `scripts/check-context-budget.js`'s `CAP_BYTES`, `INJECTION_CAP_BYTES`, `SESSION_CAP_BYTES` and `RATCHET_CAP_BYTES` and its header, `scripts/check-context-budget.test.ts`'s `CAP` and `INJECTION_CAP`, and the gate in `.husky/pre-commit`. Re-measure at the time of use rather than trusting any figure written here — `node scripts/check-context-budget.js` prints every surface.

The cheapest shed is a rule whose **full body already exists** behind a live trigger, so relocating it to a pointer rewrites nothing and creates no document. The accepted cost is that a session reaching that rule by another route meets the guard's denial without the escape route in front of it.

**The ratchet fires on net bytes, so subtraction is the first move on a false rule.** A tranche measuring net zero or below adds no always-loaded bytes and owes nothing. Rewriting a false sentence true is usually cheaper than appending a qualification to it (mantahostels#1046). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**The ratchet gates `.husky/pre-commit`, on direction rather than level (mantahostels#1224).** A commit is refused when its staged bytes leave either capped surface at or over its cap **and** larger than at HEAD; an over-cap total the commit did not increase stays a WARN. Both totals are read from git, HEAD against the index, never off disk. **Two routes past a refusal and no third, there being no escape variable:** shed the bytes in the same commit, or move the cap by editing this section, which is the unpayable-correction trigger firing. Shed candidates: `docs/research/always-loaded-shed-candidates.md` for the pool, `docs/research/injected-tracker-docs-shed-candidates.md` for the injected docs.

**A correction to a currently-false rule owes a shed like any addition (mantahostels#1221).** **A falsity correction takes first claim on the standing shed candidates**, ahead of any tranche adding a new rule, and **a correction that can name no shed escalates** — the unpayable-correction trigger — rather than landing unpaid.

### 5. Sheds paid — the ledger

**A tranche reconciles its opening figure against the entry below it and says where the two differ** — parallel sessions move the pool between any two measurements (mantahostels#1008, mantahostels#1297). <!-- citation-exempt: ported from mantahostels docs/doc-map.md, where each is that tracker's own issue (#803) -->

**A tranche is written in full only while it is the newest. The tranche that lands next compacts the entry it displaces** to its issue number, its date, its net byte figure, **what it did** in one clause, and its **named residual** — the conclusion about a shed candidate that stops a later session re-proposing it — plus, where the displaced entry carried a **prediction**, its **verdict**, a sixth element beside the residual and never inside it (mantahostels#1864). `scripts/check-doc-map.js`'s assertion 15 caps every entry but the newest at 440 B.

**A tranche that adds pool bytes carries a trigger verdict** — §3's step 2, answered on its own line in the newest entry (mantahostels#1788):

```
**Trigger:** <the nearest observable event — a tool call, or class of calls — before the decision the rule binds>
```

or, where step 2 names none, `**Trigger:** none nameable — <one clause saying why>`, with at least three words after the marker. Assertion 16 refuses a commit whose staged bytes grow §4's whole-file members while the ledger's newest entry carries no verdict or is the entry HEAD already held.

**Every relocation or addition writes a prediction; the tranche after it writes the verdict (mantahostels#1719).** A prediction is a falsifiable claim about how a session will behave once the tranche has landed; a cut justified purely as a duplicate carries none. Verification is a retrieval check — `node scripts/count-guard-fires.js`, with `--since <date>` — and **a fire proves the text was printed, never that it was read** (mantahostels#1264). The prediction ripens the first time its subject fires at or after its date (mantahostels#1886); until then **not yet ripe** is a recorded verdict, never a skip, and the unripe prediction is carried into the displacing entry (mantahostels#1888). **Falsification obliges an act**: where the falsified prediction was the shed's own justification — a route (e) cut whose guard never fired — the bytes are restored, priced as any addition.

- **Sheds paid, most recent first:**
  - **#2478, 22 Oct 2026, net +288 B**, from 16,913 B as `check-context-budget.js` read it at HEAD to 17,201 B, under cap, 5,299 B headroom left; 5 B below #2285's closing 16,918 B, parallel tranches between. Restored core voice's report-a-session-by-name rule, dropped unruled by mantahostels#1505's rewrite, and added naming a non-session process by its role, folded into the gloss paragraph so no new pool rule item. **Trigger:** none nameable — it binds while the reply is written, a moment no matcher reaches. **Prediction:** no founder correction of a pid or session id quoted as a session's or lander's name in a session's reply after 22 Oct; one falsifies it.
  - **#2285, 22 Oct 2026, net +236 B**: restored the Biome-by-path line and the status-marker sentence #2282 found breached more once cut. **Prediction:** fewer `npx biome` refusals per session than #2282's arm B (35 in 50). **Verdict:** unread — `guard-npm-install.sh` fired 10 times since 22 Oct, not split by `npx biome`; carried.
  - **#2034, 18 Oct 2026, net −25,210 B**: applied #1946's admission verdicts, moving 50 guard-printed rules from `CLAUDE.md` to `docs/agents/guard-registry.md` and re-seating the cap at 22,500 B. Residual: rows 80, 95 and 119 stayed, their guards not printing the rule. **Verdict:** falsified for the Biome rule — `guard-npm-install.sh` refused `npx biome` in 34 of 50 arm-B runs with no prior print (#2282); restored by #2285.
