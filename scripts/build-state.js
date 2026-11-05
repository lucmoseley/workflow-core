#!/usr/bin/env node
/*
 * build-state.js — create or resume a build unit's state file (#4410).
 *
 *   node scripts/build-state.js <n> [--spec <parent>]
 *
 * Prints the file's path, then its content. A missing file is created in the
 * shape `lib/build-state.js` fixes, `spec` from `--spec`; an existing one is
 * left as it is, so a successor resumes its predecessor's. The session fills
 * and rewrites it itself; the compaction hook names it in its re-read.
 *
 * IN NO SCRIPT FAMILY (docs/code-standards-base.md §N3). Exit 0 printed, 1 the
 * file could not be read, parsed or written, 2 bad usage.
 */

const fs = require("node:fs");
const path = require("node:path");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { buildStateFile, newBuildState } = require("./lib/build-state.js");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const { caught } = require("./lib/caught.js");
const { parseIssueNumber } = require("./lib/issue-number.js");

const USAGE = "usage: node scripts/build-state.js <n> [--spec <parent>]";

/** @param {string[]} argv */
function main(argv) {
	const { flags, positionals } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--spec": "value" },
		min: 1,
		max: 1,
	});
	const issue = parseIssueNumber(positionals[0]);
	const specArg = flagValue(flags, "--spec");
	const spec = specArg === undefined ? null : parseIssueNumber(specArg);
	if (!issue || (specArg !== undefined && !spec)) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	const file = buildStateFile(issue);
	try {
		if (fs.existsSync(file)) {
			const text = fs.readFileSync(file, "utf8");
			JSON.parse(text);
			process.stdout.write(`Resumed ${file}\n${text.trimEnd()}\n`);
			return 0;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const text = `${JSON.stringify(newBuildState(issue, spec), null, "\t")}\n`;
		writeFileAtomic(file, text);
		process.stdout.write(`Created ${file}\n${text}`);
		return 0;
	} catch (e) {
		process.stderr.write(`${file}: ${caught(e).message}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
