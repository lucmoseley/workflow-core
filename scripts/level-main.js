#!/usr/bin/env node

const { caught } = require("./lib/caught.js");
const { scriptPath } = require("./lib/script-path.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { buildReport, level } = require("./lib/level-main.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const store = require("./lib/arbiter-store");
const { writeFd } = require("./lib/write-fd.js");

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: `usage: node ${scriptPath("level-main.js")} [--quiet]`,
	flags: { "--quiet": "boolean" },
};

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const root = mainCheckout(process.cwd());
	if (root === null) {
		writeFd(2, "level main: no main checkout holds this directory\n");
		return 1;
	}
	try {
		const at = now();
		const outcome = level(root, {
			lastWriter: (rel) => store.readLastWriterOf(rel, { root }),
			now: at,
		});
		const report = buildReport(root, outcome, {
			now: at,
			quiet: parsed.flags["--quiet"] === true,
		});
		writeFd(2, report.text);
		return report.code;
	} catch (err) {
		writeFd(
			2,
			`levelling ${root}\nlevel main: failed: ${caught(err).message.trim()}\n`,
		);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
