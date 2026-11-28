<!-- TEMPLATE for .claude/workflow-core.md, rendered by scripts/lib/adopter-skeleton.js.
     `[roadmap]` / `[governance]` / `[site]` at the start of a line's
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

- **A push to your session's queue ref is your own act, never asked of {{founder}}; after it, in an interactive session, run `node scripts/landing-status.js --wait` in the background — it exits once each commit has landed on `main` or been dropped, so no timer is guessed. There `result:` never rests on a queue push alone; a background job ends on `result:` once its commits are queued, naming them as queued, not on `main`, and waits on the landing only where its next step needs them there.**
- **Show the diff of each change before committing it.** Unenforced.
- **Write scope is this repository.** Never write to an external surface unless the instruction names it.

## Files, claims and parallel sessions

- A script that writes a governed file must claim for itself (`rule:script-self-claim`).

## Turns, waiting and background work

- **A background job never ends its turn on `waiting:`: it holds the turn until what it launched reports, working on with its waits backgrounded while work remains and waiting in the foreground only once idle** — each foreground wait a Bash call given `timeout: 600000`: a foreground subagent, `scripts/bg-run.sh wait <name> 540` re-run, `node scripts/in-flight-runs.js wait` re-run for a test run the harness moved to the background, or, only where its next step needs its queued commits on `main`, `timeout 540 node scripts/landing-status.js --wait` re-run — since a job whose turn ends is listed completed. **Enforced**: `guard-priced-options.js` (`rule:job-holds-turn`).
- **Outside a background job, while something runs in the background, end the turn — with text and no tool call.** Say in one line, beginning `waiting:`, what was delegated and what happens with its result. Never poll: the poll guard refuses a third `ListAgents` look or output-file re-read in five minutes. **A `killed` notification is not a finished job** — `scripts/bg-run.sh check <name>` twice, 20 s apart.
- **A turn ends only on a real question or a notification you are waiting for — never on a progress report.** Unenforced.
- **A question round enumerates its answers as lettered, priced options**; `result:` asserts nothing further waits on {{founder}}. **Enforced**: `guard-priced-options.js`.

## Working patterns

- Queue actionable items at the moment they're agreed — including recommendations buried in prose, not just explicit requests. Audit against that compiled ledger.
- **Fix or file every problem you find, whether or not your task owns it.** Before the turn ends, either fix it, comment on the open issue that owns it, or file it with `--origin found-in-passing`. A problem named only in a reply is lost, and so is one left to a ticket that has since closed. A finding a subagent reports to you is yours to dispose of. **Advisory**.
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

## Removal means gone

When asked to remove, reverse or kill something, delete it and every reference to it, as if it never existed. Leave no "don't do X" line about it, no note of what changed or was removed, no deprecation or legacy comment, and no backward-compatibility code, fallback or test for the removed behaviour. Code, docs, skills and instructions describe only what is current and in use, after any change. The why goes in the issue or the commit message, never in a file.

## Leading practice

**Leading practice.** Before a task the practice gate does not exempt, find how leading professionals in its field do it and the tools they use, Claude-compatible ones (skills, plugins, MCP servers) included, and use them. Read the repo's practice note for that kind of task first; research only where none is current. Rank evidence: a standard or field body's free guidance, then named experts' verdicts with reasons, then adoption surveys and curated lists; stars and installs only check a named candidate. Where a field has no recognised authority, survey its nearest analogue (same audience or same promise); a practice no source vouches for is unverified and sets no default. Free sources only; a paywalled one is named as unread, never bought. Depart from the leading practice only for a reason this repo's rules or facts give, and say where and why. Where a domain has its own precedent step, such as design-vault's, that step is this rule there. A plugin or MCP server is never installed on a session's own reading: file a proposal ticket naming the tool, its fit, its always-on cost and its supply-chain check, for {{founder}} to rule.

**The practice gate.** Exempt: a typo or wording fix, a re-anchor or regeneration, a concision cut, propagating an already-settled fact, a revert, a version bump, a reply that only answers a question. Pick the task's craft from `docs/practice-crafts.md` in the plugin; its note is `docs/practice/<craft>.md` at the work tree root, else the plugin's copy, current for 6 months from its `Researched:` date. Where none is current, run one research pass (the `research` skill), stopping once three independent sources agree, and write or rewrite the note at the work tree root. Where no craft fits, research into a sub-section of the nearest craft's note and file a workflow-core ticket proposing the craft. Declare one line in the plan or close comment: `**Practice:** ran — <note>`, `covered — <note>, <Researched date>`, `skipped — <exempt kind>`, or `none-fits — nearest <craft>`.

## Reports and paid data

- **Nothing is reported or requested to Anthropic, of any kind**. A harness gap gets an in-repo fix or workaround, or is recorded as a harness limit. **Enforced** on the `gh` route: workflow-core's `scripts/guard-dispatch.js` refuses a `gh` issue, PR or API write it ties to an `anthropics/*` repo, printing `rule:anthropic-report`.
- **No paid research or data APIs.** What is banned is buying *facts* — a source, a feed, anything paid to answer a question. A paid tool the repo runs on is not reached by this line at all; it is an ordinary approve-before-execute call. Recommend free keyless sources and free tiers that need no card; say plainly when a tool is crippled without payment. A free tier behind a signup is welcome. **Unenforceable**: no hook can tell buying a fact from an approved paid-tool call.

## Machine

- Check the architecture before suggesting a binary or a native dependency.
- Never propose raising memory without a measured peak, and never propose raising swap.
- A build, test or session dying with no error of its own is probably the OOM killer.
- Kill a background process as soon as nothing needs it.
- Count sessions with `claude agents --json`.
