#!/usr/bin/env node
/**
 * Move stuck /implement sessions from one Claude config dir (one Anthropic
 * subscription) to another, when the source plan has run out of allowance.
 *
 * mantahostels#2605.
 *
 * list, snapshot and stop take `--from <config-dir>`, defaulting to $CLAUDE_CONFIG_DIR.
 * Nothing here writes to the repo outside --out, or takeover's and hand-off's
 * .claude/tmp/rescue/; only `stop`, `takeover` and `hand-off` are not
 * read-only.
 *
 *   list      [--from D] [--state S]      what is stuck, and where its transcript is
 *   snapshot  [--from D] --out DIR [--ids] copy state + transcript, extract narration
 *   stop      [--from D] --ids a,b,c       stop them (snapshot FIRST -- see below)
 *   probe     (--issue N | --session ID) [--interval S]
 *                                          is one named session frozen? (#620)
 *   takeover  (--issue N | --session ID) [--interval S] [--confirm-within S]
 *             [--despite SLOW|ASKING --reason TEXT]
 *                                          stop it and adopt its ticket (#621);
 *                                          --despite overrules that verdict (#622);
 *                                          a GHOST is stopped, not adopted (#1989)
 *   hand-off  --from D --job SHORT [--session ID] --issue N [--issue M]
 *                                          snapshot a stopped job, post its
 *                                          Hand-off on each issue and release
 *                                          its claim, for a fresh session (#2659);
 *                                          of a job with no record, --session
 *                                          stands in for it (#3988)
 *
 * SNAPSHOT BEFORE YOU STOP.
 *
 * cli-args-exempt: lib/rescue-cli.js's parseArgs parses it, through
 * lib/cli-args.js.
 */

const { writeFd } = require("./lib/write-fd.js");
const { ENTRIES, parseArgs } = require("./lib/rescue-cli.js");

/**
 * The production adapters: the real oracle, `claude stop`, `gh`, clock,
 * sleep and /proc.
 * @returns {import("./lib/rescue-jobs.js").RescuePorts}
 */
function productionPorts() {
	const { runOracle } = require("./lib/agent-liveness.js");
	const { spawnRaw } = require("./lib/child-spawn.js");
	const { gh } = require("./lib/gh.js");
	const { procRoot } = require("./lib/proc-root.js");
	return {
		env: process.env,
		now: Date.now,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		oracle: runOracle,
		claude: spawnRaw,
		gh,
		procRoot: procRoot(),
	};
}

/** @param {string[]} [argv] */
async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const run = ENTRIES[/** @type {keyof typeof ENTRIES} */ (args._[0])];
	const { status, stdout, stderr } = await run()(args, productionPorts());
	// writeFd: run through Bash, stdout is a pipe that process.exit truncates.
	writeFd(1, stdout);
	writeFd(2, stderr);
	process.exit(status);
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		writeFd(2, `rescue-sessions: ${e?.stack ?? e}\n`);
		process.exit(1);
	});
