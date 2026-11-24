#!/usr/bin/env node

const { collect, report } = require("./lib/concision-receipts.js");
const { scriptPath } = require("./lib/script-path.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");

const CLI = {
	usage: `usage: node ${scriptPath("concision-route-report.js")} [--dir <path>]`,
	flags: { "--dir": /** @type {const} */ ("value") },
};

/**
 * @param {string[]} argv
 * @returns {string}
 */
function receiptDir(argv) {
	return flagValue(parseOrExit(argv, CLI).flags, "--dir") ?? hostRoot();
}

if (require.main === module) {
	const dir = receiptDir(process.argv.slice(2));
	try {
		console.log(report(collect(dir)));
	} catch (err) {
		console.error(`Cannot read receipts in ${dir}: ${String(err)}`);
	}
}
