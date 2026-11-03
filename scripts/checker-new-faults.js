#!/usr/bin/env node
/*
 * Which of a checker's faults THIS COMMIT introduced (mantahostels#1688, mantahostels#1753, mantahostels#1797).
 *
 *   node scripts/checker-new-faults.js <profile> <staged.json> <baseline.json>
 *
 * The two arguments are one checker's `--json` output read twice — this
 * commit's, and a HEAD baseline. Why a gate asks at all: lib/fault-diff.js.
 *
 * NOT A `check-*` SCRIPT, and deliberately (§N3/§G4): it gates nothing and reads
 * no repository state, so runCheck's five-outcome alphabet has nothing to say
 * here — these three codes are a set-difference verdict, not a severity.
 *
 *   exit 0  every fault is inherited — WARN and pass
 *   exit 1  the lines printed are faults this commit adds — refuse
 *   exit 2  could not answer — the caller must refuse, not assume inherited
 */

const fs = require("node:fs");
const { parseOrExit } = require("./lib/cli-args");
const { runCli } = require("./lib/fault-diff");
const { PROFILES } = require("./lib/fault-profiles.js");

if (require.main === module) {
	const [profile, stagedFile, baselineFile] = parseOrExit(
		process.argv.slice(2),
		{
			usage:
				"usage: node scripts/checker-new-faults.js <profile> <staged.json> <baseline.json>",
			min: 3,
		},
	).positionals;
	const chosen = profile === undefined ? undefined : PROFILES[profile];
	if (!chosen) {
		/* writeSync, not console: the hook reads this through a pipe (§N6). */
		fs.writeSync(
			2,
			`checker-new-faults: unknown profile ${JSON.stringify(profile ?? "")} — ` +
				`expected one of ${Object.keys(PROFILES).join(", ")}.\n`,
		);
		process.exit(2);
	}
	runCli("checker-new-faults", stagedFile, baselineFile, chosen);
}
