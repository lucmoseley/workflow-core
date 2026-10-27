# CLAUDE.md

@docs/working-contract.md

## Project

workflow-core — the hooks, guards, skills and checks that let many Claude Code sessions work one shared repository at once. It ships as a Claude Code plugin: an adopting repo pins a release tag and turns modules on in `.claude/workflow-core.json`. This repo runs its own machinery on itself and has no product of its own.

## Ground truth

- **Where two rules conflict, the more specific wins, and a guard's deny text wins over any file.** Where they are equally specific: a closed issue's ruling beats the file it contradicts until re-ruled, a re-rule being a merit call; `CLAUDE.md` beats `docs/working-contract.md`; and both beat the harness's own defaults. **Where you cannot rank them, do the safer act and say in your reply which two rules you were choosing between.**
- `docs/reference-roadmap.html` is the sole authority for card status, phase and card content. Never answer a card-state question from a summary or the digest body — grep/read the HTML at the time of use. When building a card, open the HTML and read that card in full.
- **Before answering any question about card status, phase or content, read `docs/roadmap-digest.md`.** It is a derived map, not auto-loaded: state, dependencies, effort tier and execution note only.
- **Closed GitHub issues are corpus, not history** — some things, ledger items and rejected options among them, live only there. Never call a figure, term or card unsourced, undefined or undesigned on the strength of a file search; search closed issues too (`docs/agents/issue-tracker.md` §Where decisions get written).
- `docs/doc-map.md` is the authority model, not auto-loaded. **Before editing any tracked document, read `docs/doc-map.md` §A to confirm you may edit it.** Section A gives every document an authority class — that check covers any file in `docs/`, `.claude/` or `CLAUDE.md`. **Section B** is the load-bearing figure registry: when a business fact changes, walk the affected entries owner → inputs → restated-in rather than grepping, and re-derive dependent figures instead of substituting strings. **Section C** routes a question to the document that answers it, in read order — read it whenever you don't already know which file to open.
  - **Propagating a settled fact is a written pass, not a judgement call.** Read `docs/doc-map.md` §The propagation pass in full before propagating anything.
  - **Settling a load-bearing fact about the project's world — product, business, catalogue, the law binding it — obliges you to write its §B entry**, that same session. **A ruling about the repo's own machinery earns none**, going instead to its owner document — or, where that owner is always-loaded, its settling ticket. Either way report it. **Ties default to no** (mantahostels#1728): where you cannot tell which subject it is, write no entry and record it on the issue in hand. **And no entry is written unilaterally** — the fact goes to that issue, and enters §B when the founder confirms it belongs (`docs/doc-map.md` §B preamble, which owns the verifying).
  - **A fact you settle is filed the same session, to the document that owns its subject — there is no holding queue (mantahostels#2748).** Where the owner is the ticket in hand, comment on that issue — `**Captured fact:** <the fact, in plain prose>`, marked consumed as you write it. Read `docs/doc-map.md` §Capture and placement before filing, and before adding bytes to an always-loaded file.

## Commands

- `npm run status` — the repo-health checkers that no longer fire at session start; run it on demand.
- `npm run typecheck` — the only type-check; neither `lint` nor `check` is one.
- `npm run test:py` — pytest over your touched tests, across two workers (`-n 2`, pytest-xdist), through `scripts/run-pytest.js`; `-- scripts` runs the whole suite. Deps are `requirements-dev.txt`, installed by hand (`python3 -m pip install -r requirements-dev.txt`), never by `npm install`.
- Biome on named files is `node_modules/.bin/biome check <paths>` (in a worktree `npx @biomejs/biome check <paths>`), never a bare `npx biome`.

## Conventions

<!-- guard-registry:begin -->
<!-- Every rule here carries **Enforced** / **Advisory** / **Unenforced** / **Unenforceable**; `scripts/check-guard-registry.js` gates it. Rules a guard prints at need live in `docs/agents/guard-registry.md`. -->

- **A turn ends only on a real question or a notification you are waiting for — never on a progress report.** The one-line `waiting:` hand-off while something runs in the background is the exception and the only one. In a background job the last line of every turn is `result:`, `needs input:` or `waiting:`. **Unenforced** (mantahostels#1555): nothing checks the progress-report limb.
<!-- guard-registry:end -->

- **Write scope is this repository.** Do not write to, upload to, or modify any external surface — Claude Design projects, project knowledge, connectors — unless the instruction names that surface explicitly. Instructions about Chat project knowledge are operator steps for the founder, not actions to execute; Claude Code cannot write to claude.ai project knowledge.

## Machine limits

WSL2 with a **10 GB** memory cap and 2 GB swap, on **8 cores**. These are hard limits: exceeding them freezes the machine, not just the task. Never propose raising either without a measured peak, and **never propose raising swap at all** — an 8 GB swap once caused an hour-long page-fault loop, and more RAM removes the reason to want it. Full config, guards and incident runbook: `docs/environment.md`.

- The machine is Snapdragon ARM64 under WSL2. Check architecture before suggesting binaries or native dependencies.
- Kill background processes as soon as they're no longer needed.

## Subagent dispatch

**Delegate whole jobs — the bigger the job, the stronger the case.** Cost tracks the job's size, not the brief's: trimming a dispatch prompt saves nothing.

**A dispatch costs ~26k cache-write tokens before it does any work.** Dispatch where the agent will read substantially more than that floor and keep it out of the parent; a sweep over a handful of files the parent could read itself does not clear it. A floor under triviality, not a brake on fan-out.
