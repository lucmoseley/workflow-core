# What an adopter gets

Every surface workflow-core has, in four groups: what ships in the plugin, what is written into the adopter's own repo, what reaches an adopter only through this machine, and what never leaves this repo.

No companion plugin is enabled or recommended, here or in any adopter.

## Ships in the plugin

The release tree an adopter installs. Tests, fixtures and TypeScript are left out of every directory below.

- `.claude-plugin/plugin.json` `.claude-plugin/marketplace.json` — the plugin and marketplace manifests.
- `hooks/register.ts` — the entry module the plugin's hooks load.
- `.claude/output-styles` — the core-voice output style.
- `.claude/workflow-core.glossary.md` `.claude/workflow-core.doc-map.md` — the core glossary and doc-map method, rendered from this repo's `GLOSSARY.md` and `docs/doc-map.md`.
- `.claude/agents` — the review agents' type.
- `.claude/skills` — every skill, bar `new-repo`.
- `scripts` — the guards, checkers and helpers, bar the core-only scripts below.
- `scripts/measure-turn-band.js` `scripts/bench_suite_concurrency.py` `scripts/measure-bundle-cost.js` `scripts/measure-session-cost.js` `scripts/measure-outcome-review.js` `scripts/measure-ticket-mix.js` — measuring tools a shipped file tells its reader to run, so they ship although their kind stays behind.
- `scripts/browser-profile-guard.sh` — refuses a command that would open a URL in a Chrome profile other than the one signed in to the session's account, derived live from `.claude.json` and Chrome's `Local State`.
- `scripts/machine-figures.sh` — prints the machine's architecture, cores, `MemTotal` and `SwapTotal` at each session start, read live.
- `scripts/practice-guard.sh` `docs/practice-crafts.md` — the practice guard, which hands over the craft list on a first touch of `docs/practice/`, refuses an off-list note and refuses once a stop whose practice line does not hold up; and the craft list it reads.
- `scripts/templates/adopter/session-rules.md` — the session rules' template, carrying the figure-free machine rules and the four working rules: Leading practice with the practice gate, removal means gone, nothing reported or requested to Anthropic, and no paid research or data APIs, worded once in `docs/working-contract.md`.
- `docs/agents` — the rule text guards and skills read at runtime, the tracker rules among them.
- `docs/effort-guide.md` — which model and effort a job gets.
- `docs/environment.md` — one machine's limits as a worked example, and which live figure each shipped guard reads.
- `docs/environment-incidents.md` — that machine's dated incidents, each with its signature and fix.
- `docs/code-standards-base.md` — the code standards every review reads.
- `docs/comment-kinds.md` — the comment keep-list `/code-review`'s Comments axis and `concision-pass` paste.
- `docs/practice` — the practice notes, without their `## In workflow-core` sections, which hold only lines that would mislead an adopter: those about workflow-core's own release notes, its CI config and its unshipped tools. A line about shipped machinery, its measured evidence included, sits in its entry and ships: an adopter's session reads the plugin's copy of a note where its own is missing or stale.
- `.husky` — the git hooks' source.
- `ruff.toml` — the Python lint rules.
- `migrations` — the release notes an adopter's upgrade walks.

## Written into the adopter

- `.husky/pre-commit` `.husky/prepare-commit-msg` `.husky/commit-msg` `.husky/pre-merge-commit` `.husky/pre-applypatch` `.husky/post-commit` `.husky/post-merge` `.husky/post-checkout` `.husky/pre-push` — the hook shims, rewritten on every upgrade.
- `scripts/browse.py` `scripts/lib/resolve-core.js` — helpers an adopter runs from its own tree, rewritten on every upgrade.
- `.claude/workflow-core.md` — the session rules, loaded at session start, rewritten on every upgrade.
- `.claude/workflow-core.reference.md` — what a session looks up rather than obeys, rewritten on every upgrade.
- `.claude/workflow-core.glossary.md` — the core's terms, which the shipped rules cite; rewritten on every upgrade, never loaded at session start. The adopter's own `GLOSSARY.md`, if any, is its own and untouched.
- `.claude/workflow-core.doc-map.md` — the doc-map method: authority classes, the rules for §A and §B, the propagation pass, and where a settled fact goes; rewritten on every upgrade, never loaded at session start.
- `.github/workflows/workflow-core-ci.yml` — one CI job on each push to `main`, sized to the account's Actions minutes: the repo's declared commands, the shipped checks on its documents and workflows, and Semgrep. Written where `.claude/workflow-core.json` carries a `ci` key, rewritten on every upgrade, and removed when the key goes.
- `.github/workflows/workflow-core-lander.yml` `.github/workflows/workflow-core-named-rerun.yml` — the queue lander's Actions pair: the whole suite on a push to a `lander/*` suite ref, one job per `fullTestShards` group, and named files on dispatch, each through `scripts/lander-ci.js`. The lander picks them by run length, as `docs/environment.md` §6 states. Written where `landingTester` is absent or `auto`, rewritten on every upgrade, removed where it pins `local`.
- `.claude/settings.json` `.gitignore` `package.json` — the core's keys, block and status script, merged into the adopter's own on every upgrade.
- `.claude/plugin-context-cost.json` `docs/data/session-cost-table.json` `.claude/registrations.json` `.claude/guard-fire-needles.json` — measured tables and registries, brought current on every upgrade.
- `CLAUDE.md` `AGENTS.md` — the adopter's own contract, written once from a template.
- `.claude/workflow-core.json` — the adopter's config: modules, commands, tracker.
- `.claude/guard-registry-anchors.json` — the guard registry's anchors, written once.
- `.claude/implicit-behaviours.json` — the guard registry's row for each hook of the adopter's own, written once, empty: the shims take theirs from the core.
- `docs/doc-map.md` `docs/doc-map-classes.json` `docs/doc-map-admissions.json` `docs/doc-map-high-water.json` `docs/doc-map-restatements.json` `docs/doc-map-retired-vocabulary.json` `docs/doc-map-superseded.json` — the adopter's own doc map and its sidecars, written once.
- `docs/code-standards.md` — the adopter's local code standards, beside the shipped base, written once.
- `docs/reference-roadmap.html` `docs/roadmap-digest.md` `docs/called-cards.md` — the roadmap module's documents, written once where it is on.
- `docs/claude-user-settings.md` — the snapshot of the founder's personal settings, read where the adopter keeps one.

## Reaches adopters through this machine only

The founder's personal copies on this laptop of what the plugin ships, kept so the repos outside the adopter channel get them too; an adopter session on this machine meets both. `npm run check:settings` holds each equal to its repo source (#5344).

- `~/.claude/CLAUDE.md` — the four working rules, each section equal to `docs/working-contract.md`'s.
- `~/.claude/hooks/practice-guard.sh` `~/.claude/practice-crafts.md` — copies of `scripts/practice-guard.sh` and `docs/practice-crafts.md`, sharing the shipped guard's per-session latch; the guard copy stands down at `Stop` where the session's project enables the plugin and pins its marketplace at a release that ships the guard, which judges there (#5394, #5410).
- `~/.claude/hooks/browser-profile-guard.sh` — a copy of `scripts/browser-profile-guard.sh`.

## Stays core-only

- `scripts/check-surface-contract.js` `scripts/generate-plugin-tree.js` `scripts/lib/plugin-tree.js` `scripts/lib/release-tags.js` `scripts/lib/surface-closure.js` `scripts/release-contains.js` `scripts/release-plugin.js` — the release build, which no adopter runs.
- `scripts/idle-maxworkers-bench.sh` — times this repo's own suite.
- The suite-size drift check — ships with `scripts`, but the repo-checks registry runs it here alone: it re-measures a memory-ladder constant taken on this repo's suite.
- `scripts/snapshot-memory.sh` — this repo's one-off memory backup.
- `scripts/typecheck-mods.js` — type-checks this repo's own mods.
- `.claude/skills/new-repo` — creates repos under the founder's account.
- The `scripts/measure-*`, `bench_*`, `probe-*` and `sample_*` instruments not listed under "Ships in the plugin" — they re-derive figures only this repo's documents hold.
- `.github` — this repo's CI: its whole suite, CodeQL and hourly alarms, run free because this repo is public. An adopter gets the workflows above instead.
- `.agents` `.claude` `docs` — everything under them not named above.
- `.claude-plugin` — anything there but the two manifests.
- `GLOSSARY.md` `self-plugin` `.out-of-scope` `skills-lock.json` — this repo's glossary, its own plugin wiring, its rejected-requests record and its vendored-skills lock.
- `.git-blame-ignore-revs` `.gitattributes` `.shellcheckrc` `.sonarcloud.properties` `biome.json` `eslint.config.mjs` `eslint.config.test.ts` `package-lock.json` `pytest.ini` `requirements-dev.in` `requirements-dev.txt` `tsconfig.build.json` `tsconfig.json` `tsconfig.strict.json` `vitest.config.ts` `vitest.setup.test.ts` `vitest.setup.ts` — this repo's own tooling configuration.
