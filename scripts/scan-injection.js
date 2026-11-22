#!/usr/bin/env node

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

/** @param {string[]} paths */
function scanFiles(paths) {
	for (const f of paths) {
		let content = "";
		try {
			content = fs.readFileSync(f, "utf8");
		} catch (e) {
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
