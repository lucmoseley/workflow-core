#!/usr/bin/env node
// lucmoseley/mantahostels#1688
const fs = require("node:fs");
const { parseOrExit } = require("./lib/cli-args");
const { runCli } = require("./lib/fault-diff");
const { PROFILES } = require("./lib/fault-profiles.js");
const { scriptPath } = require("./lib/script-path.js");

if (require.main === module) {
	const [profile, stagedFile, baselineFile] = parseOrExit(
		process.argv.slice(2),
		{
			usage: `usage: node ${scriptPath("checker-new-faults.js")} <profile> <staged.json> <baseline.json>`,
			min: 3,
		},
	).positionals;
	const chosen = profile === undefined ? undefined : PROFILES[profile];
	if (!chosen) {
		fs.writeSync(
			2,
			`checker-new-faults: unknown profile ${JSON.stringify(profile ?? "")} — ` +
				`expected one of ${Object.keys(PROFILES).join(", ")}.\n`,
		);
		process.exit(2);
	}
	runCli("checker-new-faults", stagedFile, baselineFile, chosen);
}
