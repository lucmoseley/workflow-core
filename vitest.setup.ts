import { execFileSync } from "node:child_process";
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

/* A run a case starts is no lander's, though the lander started the suite
 * (#4757). Deleted in the worker, so vitest's own process still marks the
 * suite's marker. */
delete process.env.WFC_LANDER_RUN;

/*
 * NO TEST'S GIT CALL WRITES TO THIS CHECKOUT'S REPOSITORY (#3161): a call
 * whose `cwd` misses its fixture walks up to the real `.git`. The `git` on
 * `PATH` becomes scripts/lib/host-git-guard/git, which refuses a write there.
 * `WFC_HOST_GIT_DIR` is its cache of the host, `WFC_HOST_GIT_REAL` the git
 * it runs where a test's own `PATH` holds no other. Set again on every file
 * the worker loads, so `PATH` does not stack.
 */
const guardDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"scripts/lib/host-git-guard",
);
process.env.WFC_HOST_GIT_DIR = execFileSync(
	"git",
	["rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ cwd: guardDir, encoding: "utf8" },
).trim();
const pathDirs = (process.env.PATH ?? "")
	.split(path.delimiter)
	.filter((dir) => dir && dir !== guardDir);
const realGit = pathDirs
	.filter((dir) => path.basename(dir) !== "host-git-guard")
	.map((dir) => path.join(dir, "git"))
	.find((git) => {
		try {
			fs.accessSync(git, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
if (realGit) process.env.WFC_HOST_GIT_REAL = realGit;
process.env.PATH = [guardDir, ...pathDirs].join(path.delimiter);

/*
 * NO TEST WRITES INTO THE DEVELOPER'S LIVE CLAUDE CONFIG DIR (#838).
 *
 * AN OVERRIDE, NOT A DEFAULT, unlike the `??=` blocks below: a session always has
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
 * NO TEST READS ANOTHER SEAT (#3512). The seats default to siblings of the
 * config dir above, in the shared tmpdir, where a leaked `/tmp/.claude` would
 * join every liveness read. Pinned to paths that do not exist; an override, as
 * above.
 */
process.env.WFC_CLAUDE_CONFIG_A = path.join(testConfigDir, "no-seat-a");
process.env.WFC_CLAUDE_CONFIG_B = path.join(testConfigDir, "no-seat-b");
process.env.WFC_CLAUDE_CONFIG_C = path.join(testConfigDir, "no-seat-c");

/*
 * NO TEST READS THIS MACHINE'S MEMWATCH LOG (#4557): the suite gate, the
 * type-check slot and admission hold on its Windows reading, so a guard run
 * through its real ports would answer to the machine's memory. Pinned to a path
 * that does not exist, which reads as no memwatch; an override, as above.
 */
process.env.MEMWATCH_MINUTE_LOG = path.join(
	testConfigDir,
	"no-memwatch-minute.jsonl",
);

/*
 * NO TEST REACHES THE SESSION'S HOST THROUGH CLAUDE_PROJECT_DIR (#3334).
 * Pointed at an empty dir that is no repository, a test that drops its pin, or
 * reaches hostRoot() in process, is red in CI and locally alike. An override,
 * as above; a case that pins its own still wins.
 *
 * WHAT IT DOES NOT COVER: a spawn that builds its `env` from scratch, which
 * falls back to the git top level of its cwd — the same tree in CI and locally.
 */
const testHostDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-test-host-"));
process.env.CLAUDE_PROJECT_DIR = testHostDir;
afterAll(() => fs.rmSync(testHostDir, { recursive: true, force: true }));

/*
 * NO TEST READS OR WRITES THE MACHINE'S REFILL FILES: the loop's
 * ledgers, markers and budget records, and the live headless runs every
 * liveness read lists (#2608), would join every case that reads them.
 * An override, as above, and for the same reason.
 */
const testRefillDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-refill-"),
);
process.env.WFC_REFILL_DIR = testRefillDir;
afterAll(() => fs.rmSync(testRefillDir, { recursive: true, force: true }));

/*
 * NO TEST READS OR WRITES THE MACHINE'S SECRETS FILE (#3202): a guard reaching
 * for its key would find the real one, and a pasted write-secret.js line would
 * add to it. An override, as above. WFC_SECRETS_FILE rather than
 * XDG_CONFIG_HOME, which gh and git read their own config from.
 */
const testSecretsDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-secrets-"),
);
process.env.WFC_SECRETS_FILE = path.join(testSecretsDir, "secrets.env");
afterAll(() => fs.rmSync(testSecretsDir, { recursive: true, force: true }));

/*
 * NO TEST READS THE NEWEST GREEN RUN'S TIMINGS (#4579): the run-cost report
 * and the local tester would fetch them from GitHub into the machine's
 * cache. Named at a file that never exists, so they read none, in CI and
 * locally alike. An override, as above; a case that names its own wins.
 */
process.env.WFC_SHARD_TIMINGS = path.join(testSecretsDir, "no-timings.csv");

/*
 * THE RULE STORE THE SUITE READS IS THIS CHECKOUT'S.
 *
 * Almost every guard test spawns its guard with `CLAUDE_PROJECT_DIR` pointed at
 * a throwaway git fixture, and a fixture carries no `docs/agents/rules/`. So the
 * store came back empty and lib/guard-entry.js failed closed — mantahostels#1762's one
 * exception to failing open — on cases that have nothing to do with rule text.
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
 * reader of the pushed base from `origin/main` to the session's queue ref
 * (lib/landing-refs.js), which no fixture's remote holds, so a test of it sets
 * its own (#2408).
 */
const config = createRequire(import.meta.url)(
	"./scripts/lib/workflow-core-config.js",
);
process.env.WFC_MODULES ??= config.MODULES.filter(
	(m: string) => m !== "landing",
).join(",");

/* NO HOST LOAD CEILING, outright: `~/.claude/load-ceiling` (#3223)
 * would move every load-hold case's ceiling. */
process.env.WFC_LOAD_CEILING = "";

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
