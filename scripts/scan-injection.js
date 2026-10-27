#!/usr/bin/env node
/*
 * scan-injection.js — lib/injection-scan.js's patterns run over files, for
 * measurement (mantahostels#1806).
 *
 * Usage:
 *   node scripts/scan-injection.js --file <path>…
 *
 * It exists because mantahostels#1806's first acceptance criterion is a STANDING
 * noise threshold (~1 spurious warn per 20 sessions), not a one-off:
 * re-measuring it has to run the shipped patterns, not a copy of them. The
 * hook path is the PostToolUse dispatcher's core (#2787).
 *
 * One line per file that fires, EXEMPT or UNREAD; exit 0, or 2 on a usage
 * error.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const { isExempt, scan } = require("./lib/injection-scan.js");

const CLI = {
	usage: `usage: node ${scriptPath("scan-injection.js")} --file <path>…`,
	flags: /** @type {const} */ ({ "--file": "boolean" }),
	max: Number.POSITIVE_INFINITY,
};

/**
 * The `--file` mode: one line per file that fires, EXEMPT or UNREAD.
 * @param {string[]} paths
 */
function scanFiles(paths) {
	for (const f of paths) {
		let content = "";
		try {
			content = fs.readFileSync(f, "utf8");
		} catch (e) {
			/* Named on stderr, never swallowed: a file the run could not read is
			 * a hole in the noise figure, and a human reads this output. */
			writeFd(2, `UNREAD ${f}: ${e}\n`);
			continue;
		}
		if (isExempt(f)) {
			writeFd(1, `EXEMPT ${f}\n`);
			continue;
		}
		const r = scan(content);
		if (r.severity)
			writeFd(1, `${r.severity}\t${f}\t${r.patterns.join(",")}\n`);
	}
	return 0;
}

/** @param {string[]} argv */
function main(argv) {
	const { flags, positionals } = parseOrExit(argv, CLI);
	if (!flags["--file"]) {
		writeFd(2, `${CLI.usage}\n`);
		return 2;
	}
	return scanFiles(positionals);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
