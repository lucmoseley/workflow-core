#!/usr/bin/env node

const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { runCutover } = require("./lib/cutover-run.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const CLI = { usage: `usage: node ${scriptPath("cutover-main-checkout.js")}` };

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const root = mainCheckout(process.cwd());
	if (root === null) {
		writeFd(2, "cutover: no main checkout holds this directory\n");
		return 1;
	}
	try {
		const { result, lines } = runCutover(root);
		writeFd(
			2,
			`${(result.status === "busy" ? ["refused: another run is cutting the main checkout over now"] : lines).join("\n")}\n`,
		);
		return result.status === "cut-over" ? 0 : 1;
	} catch (err) {
		writeFd(2, `cutover: failed: ${caught(err).message.trim()}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
