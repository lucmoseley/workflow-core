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
- `docs/agents` — the rule text guards and skills read at runtime, the tracker rules among them.
- `docs/effort-guide.md` — which model and effort a job gets.
- `docs/environment.md` — the machine's measured limits the shipped guards enforce.
- `docs/code-standards-base.md` — the code standards every review reads.
- `docs/practice` — the practice notes, without their `## In workflow-core` sections: an adopter's session reads the plugin's copy of a note where its own is missing or stale.
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
- `.claude/settings.json` `.gitignore` `package.json` — the core's keys, block and status script, merged into the adopter's own on every upgrade.
- `.claude/plugin-context-cost.json` `docs/data/session-cost-table.json` `.claude/registrations.json` `.claude/guard-fire-needles.json` — measured tables and registries, brought current on every upgrade.
- `CLAUDE.md` `AGENTS.md` — the adopter's own contract, written once from a template.
- `.claude/workflow-core.json` — the adopter's config: modules, commands, tracker.
- `.claude/guard-registry-anchors.json` — the guard registry's anchors, written once.
- `docs/doc-map.md` `docs/doc-map-classes.json` `docs/doc-map-admissions.json` `docs/doc-map-high-water.json` `docs/doc-map-restatements.json` `docs/doc-map-retired-vocabulary.json` `docs/doc-map-superseded.json` — the adopter's own doc map and its sidecars, written once.
- `docs/code-standards.md` — the adopter's local code standards, beside the shipped base, written once.
- `docs/reference-roadmap.html` `docs/roadmap-digest.md` `docs/called-cards.md` — the roadmap module's documents, written once where it is on.
- `docs/claude-user-settings.md` — the snapshot of the founder's personal settings, read where the adopter keeps one.

## Reaches adopters through this machine only

The founder's personal files on this laptop, which every session on it loads whatever repo it is in. A cloud session would get them through the setup-script route recorded on #3996, the browser guard excepted; a replacement laptop restores them from the reference copy in `docs/claude-user-settings.md` (#5292).

- `~/.claude/CLAUDE.md` — Leading practice and the practice gate, removal means gone, nothing reported or requested to Anthropic, and no paid research or data APIs.
- `~/.claude/hooks/practice-guard.sh` — refuses a plan or close missing its practice line.
- `~/.claude/hooks/browser-profile-guard.sh` — keeps browser sessions off the founder's own profile.

## Stays core-only

- `scripts/check-surface-contract.js` `scripts/generate-plugin-tree.js` `scripts/lib/plugin-tree.js` `scripts/lib/release-tags.js` `scripts/lib/surface-closure.js` `scripts/release-contains.js` `scripts/release-plugin.js` — the release build, which no adopter runs.
- `scripts/idle-maxworkers-bench.sh` — times this repo's own suite.
- `scripts/snapshot-memory.sh` — this repo's one-off memory backup.
- `scripts/cut-mantahostels.js` — mantahostels' one-time cutover.
- `scripts/typecheck-mods.js` — type-checks this repo's own mods.
- `.claude/skills/new-repo` — creates repos under the founder's account.
- The `scripts/measure-*`, `bench_*`, `probe-*` and `sample_*` instruments not listed under "Ships in the plugin" — they re-derive figures only this repo's documents hold.
- `.github` — this repo's CI. An adopter writes its own; init detects it, and the lander needs none, running the local tester unless `landingTester` is `actions`.
- `.agents` `.claude` `docs` — everything under them not named above.
- `.claude-plugin` — anything there but the two manifests.
- `GLOSSARY.md` `self-plugin` `.out-of-scope` `skills-lock.json` — this repo's glossary, its own plugin wiring, its rejected-requests record and its vendored-skills lock.
- `.git-blame-ignore-revs` `.gitattributes` `.shellcheckrc` `.sonarcloud.properties` `biome.json` `eslint.config.mjs` `eslint.config.test.ts` `package-lock.json` `pytest.ini` `requirements-dev.in` `requirements-dev.txt` `tsconfig.build.json` `tsconfig.json` `tsconfig.strict.json` `vitest.config.ts` `vitest.setup.test.ts` `vitest.setup.ts` — this repo's own tooling configuration.
