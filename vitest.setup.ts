import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import "@testing-library/jest-dom/vitest";

/*
 * NO FIXTURE'S GIT CALL REACHES THE REAL REPO THROUGH AN INHERITED GIT_DIR
 * (#1677).
 *
 * The variables that point git at a repository; `GIT_CONFIG_*` stays, the
 * suite setting its own below.
 *
 * AN OVERRIDE, deleted outright: a case that wants one sets it in its child's
 * env. Done here, in the worker before any test file loads, so every route
 * into vitest is covered; vitest's own process keeps its git environment, so
 * the tree-watch globalSetup still reads a hook's private index.
 */
for (const name of [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
])
	delete process.env[name];

/*
 * NO TEST WRITES INTO THE DEVELOPER'S LIVE CLAUDE CONFIG DIR (#838).
 *
 * AN OVERRIDE, NOT A DEFAULT, unlike every block below: a session always has
 * the variable set, so `??=` would never fire. A case that sets its own — in a
 * child's env, or on `process.env` inside the case — still wins. The dir is no
 * seat, so `storeConfigDir()` keeps the arbiter's store inside it.
 *
 * WHAT IT DOES NOT COVER: a spawn that builds its `env` from scratch instead of
 * spreading `process.env`, which falls back to `~/.claude`.
 */
const testConfigDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-config-"),
);
process.env.CLAUDE_CONFIG_DIR = testConfigDir;
afterAll(() => fs.rmSync(testConfigDir, { recursive: true, force: true }));

/*
 * NO TEST READS THE MACHINE'S REFILL FILES (#2608): every liveness read lists
 * the live headless runs in their store, so a run on this machine would join
 * every case's listing. An override, as above, and for the same reason.
 */
const testRefillDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-refill-"),
);
process.env.WFC_REFILL_DIR = testRefillDir;
afterAll(() => fs.rmSync(testRefillDir, { recursive: true, force: true }));

/*
 * THE RULE STORE THE SUITE READS IS THIS CHECKOUT'S.
 *
 * Almost every guard test spawns its guard with `CLAUDE_PROJECT_DIR` pointed at
 * a throwaway git fixture, and a fixture carries no `docs/agents/rules/`. So the
 * store came back empty and `gp_rule` exited 2 — mantahostels#1762's one exception to
 * failing open — on cases that have nothing to do with rule text.
 *
 * IT IS A DEFAULT, NOT AN OVERRIDE. A case that wants a different store — an
 * empty one, a store missing a fragment, a fixture's own — still sets
 * `WFC_RULES_DIR` in the child's env, and the child's own value wins.
 *
 * WHAT IT DOES NOT COVER: a spawn that builds its `env` from scratch instead of
 * spreading `process.env`.
 */
process.env.WFC_RULES_DIR ??= path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"docs/agents/rules",
);

/*
 * EVERY MODULE BUT `landing` IS ON FOR THE SUITE, by the same
 * default-not-override shape: a fixture host carries no
 * `.claude/workflow-core.json`, so a module-gated checker would SKIP on every
 * case that has nothing to do with the gate. A test of the skip deletes
 * `WFC_MODULES` from its child's env, or sets its own. `landing` moves every
 * reader of the pushed base from `origin/main` to `origin/landing`
 * (lib/landing-refs.js), which no fixture's remote holds, so a test of it sets
 * its own (#2408).
 */
const config = createRequire(import.meta.url)(
	"./scripts/lib/workflow-core-config.js",
);
process.env.WFC_MODULES ??= config.MODULES.filter(
	(m: string) => m !== "landing",
).join(",");

/* NO SESSION FLOOR, outright: the machine's `~/.claude/session-floor` (#2501)
 * would lift every admission case's slots. A case testing the floor sets its
 * own in the child's env. */
process.env.WFC_SESSION_FLOOR = "";

/* THE POOL IS THIS CHECKOUT'S, by the same shape: a fixture host declares no
 * `alwaysLoaded`, so the pool checkers would read the adopter default. */
process.env.WFC_ALWAYS_LOADED ??= (
	config.readConfig({ root: path.dirname(fileURLToPath(import.meta.url)) })
		.alwaysLoaded ?? []
).join(",");

/* THE DOUBLE-LOADED STYLE IS THIS CHECKOUT'S TOO, by the same shape: a fixture
 * host declares no `overrides.output_style`, so check-context-budget.js would
 * read the adopter default (#45) rather than this repo's own declaration. */
process.env.WFC_OUTPUT_STYLE ??=
	config.readConfig({ root: path.dirname(fileURLToPath(import.meta.url)) })
		.overrides.output_style ?? "";

/*
 * NO GIT REPO A TEST MAKES STARTS BACKGROUND MAINTENANCE (#806). A `git
 * commit` otherwise launches auto-maintenance detached, and that process
 * writes under `.git/objects` while a fixture copies or deletes the repo.
 * Set through git's environment config, so it reaches repos that never pass
 * through a fixture builder; APPENDED to any `GIT_CONFIG_COUNT` already set rather than
 * replacing it, and skipped where the same pair is already present, so a
 * reused worker does not stack copies — an inherited `maintenance.auto=true`
 * is overridden, git taking the last value. Blind spot: a spawn whose `env`
 * is built from scratch.
 */
const SUITE_GIT_CONFIG: Record<string, string> = {
	"maintenance.auto": "false",
	"gc.auto": "0",
};
let gitConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
const presentGitPairs = new Set(
	Array.from(
		{ length: gitConfigCount },
		(_, i) =>
			`${process.env[`GIT_CONFIG_KEY_${i}`]}=${process.env[`GIT_CONFIG_VALUE_${i}`]}`,
	),
);
for (const [key, value] of Object.entries(SUITE_GIT_CONFIG)) {
	if (presentGitPairs.has(`${key}=${value}`)) continue;
	process.env[`GIT_CONFIG_KEY_${gitConfigCount}`] = key;
	process.env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = value;
	gitConfigCount++;
}
process.env.GIT_CONFIG_COUNT = String(gitConfigCount);
