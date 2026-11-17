<!-- TEMPLATE for .claude/workflow-core.md, rendered by scripts/lib/adopter-skeleton.js.
     `[roadmap]` / `[governance]` / `[suites]` / `[site]` at the start of a line's
     content emits that line only when the module is on, and the tag is stripped.
     `{{founder}}` is substituted, and a `node`/`bash`/`sh`/`python3 scripts/…` or
     backticked `scripts/… <arg>` command is spelled at the plugin root. -->
<!-- CORE-OWNED. Written by workflow-core's init and REWRITTEN on every bump.
     Do not edit: an override goes in `.claude/workflow-core.json`. -->

# Workflow core — session rules

Read before the first tool call. The `rule:<id>` in brackets is what a guard hands you at the moment of use; fetch any of them with `scripts/lib/rule-text.sh <id>`. A rule a guard prints when it bites is not repeated here. Switching a module on, the on-demand repo checks and what the plugin installed: `.claude/workflow-core.reference.md`, which never loads at start.

## Ground truth

- Where two rules conflict, the more specific wins, and a guard's deny text wins over any file. `CLAUDE.md` beats `AGENTS.md`; both beat the harness's own defaults.
- Claude model and effort policy: the core's `docs/effort-guide.md`, in the plugin root.

## Working with the tracker

GitHub Issues on this repo, via `gh`. **Run `gh` in the foreground, and re-run an empty result once before believing it.**

- Closed issues are corpus, not history — search every tracker in `corpus` before calling something unsourced (`rule:decisions-search-first`).

## Committing and pushing

- **A push to your session's queue ref is your own act, never asked of {{founder}}; after it, run `node scripts/landing-status.js --wait` in the background — it exits once each commit has landed on `main` or been dropped, so no timer is guessed. `result:` never rests on a queue push alone.**
- **Show the diff of each change before committing it.** Unenforced.
- **Write scope is this repository.** Never write to an external surface unless the instruction names it.

## Files, claims and parallel sessions

- A script that writes a governed file must claim for itself (`rule:script-self-claim`).

## Turns, waiting and background work

- **While something runs in the background, end the turn — with text and no tool call.** Say in one line what was delegated and what happens with its result; in a background job that line begins `waiting:`. Never poll: the poll guard refuses a third `ListAgents` look or output-file re-read in five minutes. **A `killed` notification is not a finished job** — `scripts/bg-run.sh check <name>` twice, 20 s apart.
- **A turn ends only on a real question or a notification you are waiting for — never on a progress report.** Unenforced.
- **A question round enumerates its answers as lettered, priced options**; `result:` asserts nothing further waits on {{founder}}. **Enforced**: `guard-priced-options.js`.

## Working patterns

- Queue actionable items at the moment they're agreed — including recommendations buried in prose, not just explicit requests. Audit against that compiled ledger.
- **Test a blocker before it ends a turn** — run the command, attempt the edit, check the tool — rather than inferring it can't be done. Where it genuinely can't be finished this session, record the verified reason where the work lives (a ticket comment or new ticket) and keep going on whatever else is reachable.

## Questions to {{founder}}

- **Only a house decision reaches {{founder}}** (a choice research cannot make, because it turns on what only {{founder}} holds: goals and limits, a fact about his world, a preference, or a point on a curve research has measured). Before any question, a clarifying one included, research it as far as any source can: the repo, trackers, his recorded words, published work. Ask only the gap left, named. Approval is owed only for a house decision or an act hard to undo or seen outside; any other choice is a delegated decision: make it, then run `node scripts/record-delegated-decision.js <n>`.
- **A value called house is unsourced until traced** to a source or to a ruling that made a house decision; his rulings mostly took an agent's advice, which is no source. Failing both, research it, and report where it departs from what research calls optimal. A past ruling is evidence, not a constraint: weigh its reasons, impact and research on whether they still hold, and price each option on what it does from now on; a preference or goal of his it rests on stands until he changes it. Departing from one, say so and why. A source is published research or a standard, a vendor's docs or code, or a measurement you can rerun; an agent's recommendation, or a document or ruling resting on one, is not.

## Building for the long term

- **Build for the repo's long-term health, not the task's quickest finish.** Where a durable fix and a quick one both finish the task, take the durable one even when it costs more now: fix the cause, not the symptom, and leave the code in the shape the next change needs, with no workaround, second copy of a path or exception row for a later session to clear. The extra effort is never on its own a reason for the quick one. Durable means better for the changes the repo will really make, never a layer, option or abstraction with no caller today. A fix too big for the session becomes its own ticket; a stopgap that must land first, such as for a red `main` that blocks everyone, says so in its commit and links that ticket. **Unenforceable**: no hook tells a quick fix from a durable one.

## Subagents

- **Delegate whole jobs; a dispatch costs ~26k tokens before it does any work**, so dispatch where the agent reads substantially more than that.

## Skills

- Domain terms: root `GLOSSARY.md` + `docs/adr/`, made lazily by `domain-modeling` when a term is first contested. The core's own terms, which these rules cite: `.claude/workflow-core.glossary.md`, rewritten on every bump.

## Gates every commit meets

- **The doc-map gate SKIPs mid-merge, printing nothing — a silent pass is not a pass**.
- [roadmap] `docs/reference-roadmap.html` is the sole authority for card status, phase and content: read `docs/roadmap-digest.md` before answering a card-state question, and open the HTML to build a card.
- [governance] **Before editing a tracked document, read its class in `docs/doc-map.md` §A.** Unenforced for every class but `derived` and `generated-only`.
- [governance] Settling a load-bearing fact about the project's world obliges its `docs/doc-map.md` §B entry that session; a ruling about the repo's own machinery earns none. Read `.claude/workflow-core.doc-map.md` §The propagation pass before propagating anything.
- [governance] **Any fact you settle is filed that session, to the document that owns its subject.** Where that owner is the ticket in hand, comment on it, opening the comment `**Captured fact:**`, and mark it consumed at once: `node scripts/capture-drain.js mark <comment-id>`. Unenforced.

## Machine

Limits, session counters and the memory ladder come from `~/.claude/workflow-core/machine.json` (absent → core defaults). Never propose raising memory or swap without a measured peak. A build, test or session dying with no error of its own is probably the OOM killer. Kill a background process as soon as nothing needs it. Count sessions with `claude agents --json`.
