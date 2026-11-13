#!/usr/bin/env node
/*
 * run-arm-test.js — runs the before/after test's sessions and reads their
 * result (#2045, `docs/research/startup-load-before-after-test.md` D2–D5).
 *
 *   node scripts/run-arm-test.js plan --root <dir> --tasks <id,id…> --runs <n>
 *       --arm A=<rev>@<config dir> --arm B=<rev>@<config dir> [--seed <n>]
 *   node scripts/run-arm-test.js launch <pair>… --root <dir> --issues <dir> --node-modules <dir>
 *   node scripts/run-arm-test.js run --root <dir> --issues <dir> --node-modules <dir>
 *       [--ceiling-min <n>] [--pace-min <n>] [--max-running <n>] [--poll-sec <n>] [--limit-min <n>]
 *   node scripts/run-arm-test.js report --root <dir> --baseline <arm> [--json] [--drop <fraction>] [--every-version] [--periods <pair>,…] [--ceiling-min <n>]
 *
 * `plan` writes `<root>/plan.json`: every task × run × arm, grouped into pairs
 * of one run per arm on the same task, the pairs shuffled and the arm order
 * inside each pair drawn by coin, from `--seed` so a plan can be rebuilt. It
 * records the CLI as its versioned binary and version: `claude` on PATH is a
 * link any session's update moves, so `launch` and `run` start, list and stop
 * every run through the recorded binary, and refuse once it is gone (#2289).
 *
 * `launch` builds both sandboxes of each named pair through `arm-tasks.js
 * build`, then starts each as a `claude --bg` job in its arm's config dir, in
 * the pair's order, so neither member starts while the other is still being
 * built. A pair starts only where admission has a slot for each member and no
 * more than D5's two pairs would then be running; `run --max-running` raises
 * that cap (#2046), leaving admission the only check on the machine's memory.
 * A `--bg` job keeps the
 * launcher's PATH, which reaches the gh stub, but drops other variables
 * (#2045), so the sandbox's own variables go in its
 * `.claude/settings.local.json` `env`, which is gitignored and the same in
 * both arms. A `--bg` launch refuses a folder never trusted, so the sandbox
 * is trusted in the arm's `.claude.json` first.
 *
 * `run` is `launch` in a loop (#2046): it takes the plan's pairs in order,
 * starts the next once `--pace-min` has passed since the last start and
 * `launch` would admit it, stops a run still going past `--ceiling-min` and
 * records it `hung`, and exits once every pair has started and every run has
 * ended. Past `--limit-min` of its own it stops every run still going and
 * exits, so a run held or stuck cannot leave sessions for days (#3495); a
 * later `run` takes up the pairs not yet started. A build or launch failure,
 * or a half-launched pair, starts no more pairs, since the next pass would
 * repeat it, and exits once every run started has ended, still stopping at
 * the ceiling and the limit, so no run is left going unwatched (#3503). Where
 * the plan's CLI is gone nothing can stop a run, so it names each and the
 * `claude stop` that ends it, as it does where its loop throws (#3506). It
 * drops the starting session's id, which would outlive that session, and logs
 * why a pair is held each time the reason changes (#2046).
 *
 * `report` scores each launched run that has ended (`score-session-
 * breaches.js`), judges its sandbox (`arm-tasks.js accept`), checks the
 * harness assumptions — the live seat still signed in, each transcript and
 * job dir under its arm's own config dir, one CLI version — and prints each
 * arm's mean and within-task variance with the runs per arm a main run needs
 * against `--baseline`. A run on any CLI version but the most common is
 * listed and left out of the statistics, unless `--every-version`, the
 * founder's ruling for #2046's main run (#2241), counts it. Beside D3's
 * score it compares acceptance, wall time and spend within task (#2241),
 * prints D3's lexical secondary measures per arm (`lib/arm-secondary.js`), and
 * `--periods` names the first pair of each period after the first, for a
 * per-period split and a post hoc arm × period check. A hung run's wall time
 * counts at `--ceiling-min`, the run's ceiling.
 *
 * The logic is lib/run-arm.js's core (#5149). This shell parses argv, wires
 * the production adapters — `claude` and each Node program as real children,
 * the monotonic and wall clocks, the thread's own sleep, fd 1 and 2 — and
 * exits with the status the core returns.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing and files no issue, and it
 * writes outside the repo.
 */

const { spawnRaw } = require("./lib/child-spawn.js");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const arm = require("./lib/run-arm.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrExit(argv, arm.CLI);
	/** @type {import("./lib/run-arm.js").Ports} */
	const p = {
		env: process.env,
		claude: spawnRaw,
		node: (cli, args, opts) => spawnRaw(process.execPath, [cli, ...args], opts),
		clock: () => performance.now(),
		now: () => Date.now(),
		sleep: sleepSync,
		out: (text) => writeFd(1, text),
		err: (text) => writeFd(2, text),
		hostRoot: () => hostRoot(),
	};
	if (parsed.command === "plan") return arm.plan(p, parsed);
	if (parsed.command === "launch") return arm.launch(p, parsed);
	if (parsed.command === "run") return arm.run(p, parsed);
	if (parsed.command === "report") return arm.report(p, parsed);
	return arm.refuse(p, arm.CLI.usage);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
