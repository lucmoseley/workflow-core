# Injected tracker docs — shed candidates

**Tickets:** mantahostels#1259 and mantahostels#1268 (duplicates: the same question, same map). Map mantahostels#1055 (the always-loaded pool is over cap).
**Measured:** 24 August 2026, `node scripts/check-context-budget.js` — injection **57,649 B of 57,652 B, 3 B headroom**. `docs/agents/issue-tracker.md` 43,050 B + `docs/agents/triage-labels.md` 14,599 B.

The surface is at zero practical headroom, so the next byte added to either file is refused by `.husky/pre-commit` (mantahostels#1224).

**The routes available here are four, not the pool's five.** The pool's route (b) — "move it into the injected tracker docs" — is the surface being shed *from*. What is left: **(a)** the skill file that runs when the fact bites · **(c)** a pointer line inside the injected doc, body relocated to an on-demand file · **(d)** nothing at all · **(e)** a guard that reprints the text verbatim when it fires, verified against the guard's own output string and never by subject (mantahostels#886).

**Route (a) is almost entirely unavailable.** Five of the six commands these docs reach — `/wayfinder`, `/to-spec`, `/to-tickets`, `/implement`, `/triage` — are vendored symlinks into `.agents/skills/` with a `computedHash` in `skills-lock.json`; an edit is reverted on the next vendor pull. Only `/card-close` is project-owned (`.claude/commands/card-close.md`). So a `/wayfinder`-only fact has no skill file to move to.

**Reach lost by each relocation.** Both documents reach six of the seven commands; `/code-review` takes the disposition rule alone and neither document. A body moved behind a pointer reaches only the session that follows the pointer. A body moved into a `scripts/*` header reaches only the session that opens that script.

---

## Two structural findings, before the candidate list

### 1. The injector's own header is injected and **not counted** — do not shed into it

`scripts/check-context-budget.js` measures the `DOCS=(...)` array alone. The header prose the same script builds — `$header`, `$priced_options`, `$disposition`, `$standards`, `$dispatch`, `$deviations_read`, `$deviations_write`, `$ultra`, `$closing_steps` — is pasted into the same payload and charged nothing. mantahostels#1235 names this as the cap's residual.

That makes moving a span out of the two documents and into a header variable a **cut of measured bytes at zero real saving** — the session receives the identical text.

**The gap is already measured.** [docs/research/tracker-injection-frequency.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md) (mantahostels#1083, which measured what the injector actually sends) puts the true payload at **61,180 B, and 63,291 B for `/implement`** — against a cap of 57,652 B. The difference is the uncounted header.

**Recommendation: bar it explicitly**, in `docs/doc-map.md` §Capture and placement §4 beside the existing residual sentence, and count the header in `check-context-budget.js`. Counting it is itself trigger (ii) — a scope change, which bumps the cap by exactly the bytes folded in and is therefore headroom-neutral.

### 2. Subset injection is buildable but returns **no headroom**

`scripts/inject-tracker-docs.sh` could paste a per-command subset instead of whole files. Sections reaching one command only:

| Section | B | Needed by |
|---|---|---|
| §Wayfinding operations | 4,418 | `/wayfinder` |
| §Research artefacts: written outside the repo | 2,984 | `/wayfinder` |
| §Two dependency graphs | 685 | `/wayfinder` |
| §A `/wayfinder` research subagent that stalls | 623 | `/wayfinder` |
| §Closing a `kind:ticket` issue | 1,296 | `/implement`, `/card-close` |
| **Total `/wayfinder`-only** | **8,710** | |

**Why it buys nothing against the cap.** The cap is 57,652 B, "what those two documents weighed on 24 August 2026" (mantahostels#1235). Redefining the measured surface as per-command payload is trigger (ii), a **scope change** — and doc-map §4 fixes scope changes as byte-neutral: *"a widening bumps the value by exactly the bytes folded in, a narrowing cuts it the same way, so the change is always scope-neutral and a wider scope at the old number would be a tightening by stealth"*. A narrowing to max-per-command sets the cap to today's max-per-command, and headroom is again zero.

**What it buys has been priced, and it is small.** [docs/research/tracker-injection-frequency.md](https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md) (mantahostels#1083) measured where the injection cost sits: **95% of it is `/implement` (232.5 firings/week) and `/wayfinder` (147.5/week), both of which need most of the document**, so per-command slicing recovers only about **$63-equivalent a week of $414** — ~6.7% of all spend. `docs/research/tracker-index-prototype.md` (mantahostels#1118, which prototyped the alternative) beats it outright: a **3,343 B index plus on-demand fetches costs 61.9% less** than the injection, and is cheaper at any fetch volume — a session pulling every rule still saves 9.4%. That is a cost question, not a headroom question, and the index is the better ticket.

**What it costs.** The heading→commands map has to be data (a manifest in the script), not prose — and a heading added without a manifest entry then reaches either nobody or everybody, silently. It also splits `check-context-budget.js`'s measurement into seven, and its test with it.

---

## Accepted candidates — ranked by net bytes returned

| # | Span | File · line | Cut B | Repl. B | **Net** | Cum. | Route |
|---|---|---|---|---|---|---|---|
| I1 | §Producer/consumer contract, whole section | `issue-tracker.md` L265–290 | 5,677 | 220 | **5,457** | 5,457 | (c) → `docs/agents/tracker-fields.md` |
| I2 | §Session naming, whole section | `issue-tracker.md` L244–264 | 1,961 | 150 | **1,811** | 7,268 | (c) → `scripts/name-issue-session.sh` header |
| I3 | `check-issue-card-drift.js`'s four paragraphs | `issue-tracker.md` L52–67 | 1,048 | 150 | **898** | 8,166 | (c) → that script's own header |
| T1 | *"Two things about the deny"* — restates L36 | `triage-labels.md` L50 | 1,158 | 330 | **828** | 8,994 | dedupe, no route needed |
| I4 | The raw `sub_issues` POST traps | `issue-tracker.md` L220, L224 | 923 | 90 | **833** | 9,827 | (c) → `scripts/link-sub-issue.sh` header |
| I5 | *"Changing body text means download-whole…"* | `issue-tracker.md` L139 | 485 | 0 | **485** | 10,312 | (e) `guard-issue-body.sh` deny |
| I6 | §Every close — the marker's two homes, and the judgement rationale | `issue-tracker.md` L71, L73 | 333 | 0 | **333** | 10,645 | (e) `guard-issue-close.sh` `deny()` |
| I7 | The ✅/❌ citation examples | `issue-tracker.md` L178–180 | 298 | 0 | **298** | 10,943 | dedupe against the injected header |
| I8 | The `mantahostels#275` discriminator and its residual | `issue-tracker.md` L46–50 | 365 | 40 | **325** | 11,268 | (e) `guard-issue-close.sh` `deny_card()` |
| I9 | *"Prefer a comment over a body edit…"* | `issue-tracker.md` L162 | 175 | 0 | **175** | 11,443 | (e) `guard-issue-body.sh` deny |
| T2 | *"A `takes:` value overrides…"* — restates L66 | `triage-labels.md` L48 tail | 146 | 0 | **146** | **11,589** | dedupe, no route needed |

**Total available: 11,589 B — 20% of the 57,652 B surface.**

---

## The evidence behind each claim

### Route (e), verified against the guard's own output string

**I5 — `scripts/guard-issue-body.sh`.** Its `deny()` prints verbatim:

> A body write is download-whole/upload-whole and GitHub offers no conditional write (mantahostels#128), so the second of two sessions editing one issue silently wipes the first — that is the 4 August 2026 loss on mantahostels#96.

L139 says the same thing at greater length (the PATCH-400, the absent GraphQL version field, `updated_at`'s one-second resolution). Those three mechanisms are *evidence for* the conclusion the deny already states; a session meeting only the deny routes through `issue-body.js` correctly. **Keep the heading** — the deny's last line is *"Commands and recovery: docs/agents/issue-tracker.md §Editing an issue body"*, so the section must stay findable.

**I9 — same deny, last paragraph:** *"Prefer a comment where the content allows it — `gh issue comment` creates a new resource and cannot be clobbered at all."* L162 is that sentence.

**I6 — `scripts/guard-issue-close.sh` `deny()`** prints *"Add a line to the resolution comment (or to this close's own --comment) that starts:"*, which is L71 whole, and *"The guard reads whether the line is present, never what it says — the judgement is yours"*, which is L73's operative half. Cut L73's justification only — the two identically-reading examples (235 B). **Keep** *"`--reason "not planned"` is skipped"* (printed by `deny_card()`, not by `deny()`) and **keep** *"A close through the GitHub UI, or via `gh api --method PATCH`, is not seen"*, which is guard silence a session reads — the class `concision-pass` protects by name (mantahostels#605).

**I8 — `deny_card()`** prints the `/card-close` recipe, *"Doing it by hand does not just skip the roadmap edit, it forecloses the fix: /card-close step 1 refuses to run on an issue that is already CLOSED"*, and the escape for the borrowed-prefix case: *"If this is not that card's own issue — a spin-off that borrowed the prefix — or the work is being abandoned, close with --reason "not planned", which this guard skips."* That covers L46–50's discriminator and its residual. **Keep L42** — the non-card close (`gh issue close`, the UI, a merge keyword) leaves the roadmap stale and this guard never fires on it, so nothing prints that at all.

### Route (c), relocation to a body a session reaches when the fact bites

**I1 — §Producer/consumer contract.** Six commands carry 5,677 B of it on every firing; the rule it states — *"When a skill starts writing a new field, add its row and name the consumer"* — binds a session changing the tracker's machinery, which is rare. Nothing prints any of it. **This is the largest single risk on the list**, because the table's passive value is that a session absorbs a row without going looking. Replace with a pointer naming the file and the one rule: *"Every structured field written into the tracker needs a named reader — the field/producer/consumer table is `docs/agents/tracker-fields.md`; add a row when a skill starts writing a new field."* Needs a `docs/doc-map.md` §A row for the new file.

**I2 — §Session naming.** 1,961 B telling six commands about a hook that asks nothing of them: `CLAUDE.md` already says *"rename the session via a hook — nothing to do."* The content — the six-command name table, the front-of-argument parsing rule, the two-write ordering, mantahostels#998's residuals — is debugging material for whoever edits `scripts/name-issue-session.sh`. Move it into that script's header, which needs no §A row (`check-doc-map.js` scopes `docs/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, `PRODUCT.md`, `DESIGN.md`). Re-point `CLAUDE.md`'s existing pointer from `docs/agents/issue-tracker.md §Session naming` to the script; the two strings are within a few bytes, so the pool moves by roughly nothing — which matters, the always-loaded pool having 7 B of headroom of its own.

**I3 — `check-issue-card-drift.js`.** Four paragraphs of that reporter's scoping rules (mantahostels#275's parentage test, mantahostels#277's UNPARSEABLE TITLE narrowing, `--json`). It runs weekly and on `npm run check:issues`; none of it is needed before a tracker call. Move to the script's header, leave *"`scripts/check-issue-card-drift.js` remains the backstop… It only ever reports"*.

**I4 — the raw `sub_issues` POST traps.** L218 already says *"Link a child with `scripts/link-sub-issue.sh <parent> <child>`… Reach for the raw call only when it refuses."* That script's header **already encodes all four traps verbatim** — `-f` sending a string where the endpoint wants an integer, `-F sub_issue_id=$(gh api …)` sending empty on a transient error, `parent_issue_url` lagging by minutes so verification reads from the parent side, and a 422 naming an existing parent being proof the first call worked. So L220 and L224 are a second copy of a body the session is already told to open. **Keep L222** (read parentage from `parent_issue_url`, never by walking `/sub_issues`) — that is about *reading*, which `link-sub-issue.sh` does not do.

### Dedupe — real bytes at no retrieval cost

**T1 — `triage-labels.md` L36 and L50 are the same paragraph twice.** Both state: GraphQL takes node ids so `labelIds` cannot be judged · deny without them, warn with them · a query read from a file, stdin, a variable or a command substitution passes in silence · warning there was rejected because it would fire on the read-only GraphQL run daily, which `guard-issue-body.sh` already warns on · a hook sees Bash only, so a script and the web UI file bare · `check-issue-labels.js` is the control.

Cut L50 (1,158 B), the longer copy, and fold its three unique clauses into L36 (~330 B): *"every `takes:` word on the command is validated, not just the first"* · the live instance, mantahostels#464, filed by `scripts/report-manual-staleness.js` inside a workflow · *"this does not reverse mantahostels#136"*. **Keep L36's** *"a warning is a prompt to check the label, not a claim that one is missing"* — guard-output interpretation, mantahostels#605's protected class.

**T2 — L48's tail restates L66.** L48 ends *"A `takes:` value overrides a `wayfinder:*` or `kind:` label disagreeing with it; the older families stay because machines read them too"*; L66 is the same sentence with the worked example (mantahostels#172 is `wayfinder:task` but takes `/implement`). Cut L48's tail, keep L66.

**I7 — the citation examples are already in the injected header.** `inject-tracker-docs.sh`'s `$header` carries, today, to all seven commands: *"(3) cite an issue number-first — `#22 (gloss)`, never `[title](url)` or a bare description; `to-tickets`'s "numbers/titles" is wrong on the order."* L178–180's ✅/❌ list says exactly that. **Keep L176** (the rule and why the number is the resolving token) and **L182** (GitHub's own Blocked-by panel puts the title first — the exception the header does not carry).

---

## Rejected candidates, with reasons

| Span | File · line | B | Why rejected |
|---|---|---|---|
| §Placing a new issue — the three placement options (a)/(b)/(c) | `issue-tracker.md` L208–212 | 582 | **Route (e) refused by the hook's dominant-path output.** `scripts/place-new-issue.sh` prints all three verbatim *only* where it can read the created issue's number. On a **backgrounded** `gh issue create` — which §Running `gh` at all makes the standing advice — the output is the job stub, and the hook falls to a reduced text: *"Make it a sub-issue of whichever issue spawned it, or say in its body that it is deliberately standalone."* Option (b), peer work under the same parent, and the `gh api …/issues/<n> --jq .parent_issue_url` recipe are printed on neither backgrounded creates nor the second create in one prompt (`place=0`). |
| §Running `gh` at all — what this machine's `gh` cannot do | `issue-tracker.md` L5–14 | 2,929 | **Pinned by its own paragraph** at mantahostels#716: *"Moving it to a `docs/agents/gh-mechanics.md` the tracker doc points at was rejected at mantahostels#716: a pointer buys a second read for 6% of the bytes and adds a §A row to keep. Re-raise only against a materially larger share."* It is now **2,929 B of 43,050 — 6.8%**, against the 6.1% recorded there. Not materially larger. ⚠ **Bookkeeping:** that paragraph's own figures (*"2,493 bytes of 41,097 — 6.1%"*) are stale and should be regenerated when anything else in the file moves. |
| §`takes:` — the seven-value table | `triage-labels.md` L38–46 | 588 | **Borderline, listed for the applying session, not counted.** `place-new-issue.sh`'s `takes_values` reprints all seven **with meanings and commands**, and on a backgrounded create it fires unconditionally, having no way to read the labels. But it is `PostToolUse` — it arrives *after* the create — while `guard-issue-create-label.sh` denies *before* and prints `values_line()`, which is the seven bare values with **no meanings**. So a session picking a value for the first time chooses from bare names plus the `takes:triage` default. Reversible after the fact, not correct in the moment. |
| §Claiming — the issue you are working now | `issue-tracker.md` L226–243 | 3,999 | **No route.** `scripts/record-issue-claim.sh` and `scripts/release-issue-claim.sh` emit **nothing to the session** — they write the arbiter record silently. The five routes neither hook sees (web UI, script, `gh api`, `--repo`, a variable issue number) are precisely the cases where nothing fires at all, so the instruction to make the call by hand can only arrive by being read first. |
| §Wayfinding operations — the frontier query's refusal semantics | `issue-tracker.md` L317 (within L295–307) | — | Partially route (e): `scripts/wayfinder-frontier.js` prints on stderr *"…so the frontier is unknown — not empty. Drop nothing on this answer."* and *"the claim filter cannot be vouched for and a frontier built on it could offer work another session is already doing. Refusing."* But the **operative reading instruction** — *"a non-zero exit prints nothing and means the frontier is unknown — hand the step back, and never read it as 'nothing is left to do on this map'"* — must be read **before** the command runs, since the failure mode is misreading an empty stdout. Guard silence a session reads: mantahostels#605's protected class. |
| §Wayfinding operations, §Research artefacts, §Two dependency graphs, §research subagent that stalls | `issue-tracker.md` | 8,710 | `/wayfinder`-only, and `/wayfinder` is vendored and hash-locked, so **route (a) does not exist for them**. Only subset injection reaches them, and it returns no headroom (finding 2 above). §Research artefacts additionally says *"Don't move this rule into the skill: `wayfinder` is vendored, so hand-edits are lost on re-vendor"* — the same bar, already recorded in place. |
| §Editing an issue body — the verification semantics | `issue-tracker.md` L152–156 | 1,541 | Nothing prints *"`written and verified` is the only success signal — every subcommand exits 0 on refusal and on network failure alike"*, *"run one subcommand per Bash call"*, `append-section`'s single-line and existing-section refusals, or the idempotence requirement. All four are read **before** the helper is run, and all four are silent-failure traps. |
| §Editing an issue body — the `--body` backtick trap and `$CLAUDE_JOB_DIR` | `issue-tracker.md` L164–166 | 1,679 | Both failures are **invisible**: a comment posts looking fine minus one word, and `cat <job-file> \| gh … --body-file -` exits with no output, no error and no comment created. Nothing fires. This is the class a shed can never touch. |
| §Closing a `kind:ticket` issue | `issue-tracker.md` L79–91 | 1,296 | `scripts/check-ticket-criteria.js` reports weekly, after the close. The four-step order — re-read the body, tick one call each, `annotate --text "**waived:**"`, then close — has to be read first, and the injected header carries only step 3. Reachable by subset injection (`/implement`, `/card-close`) alone. |
| `AGENTS.md`, `CLAUDE.md`, `docs/working-contract.md`, any span | — | — | Out of scope: different surface, different cap. Standing list is `docs/research/always-loaded-shed-candidates.md` (mantahostels#1222). |

---

## Method note

Spans were cut at paragraph or section boundaries and byte-counted with `sed -n '<a>,<b>p' <file> \| wc -c`, continuation and trailing blank lines included.

**Before applying any cut:** re-measure with `node scripts/check-context-budget.js`; keep every section heading a guard's deny text names as its `Rule:` pointer; and add the `docs/doc-map.md` §A row for any new file in the same commit.
