#!/usr/bin/env node
/*
 * cutover-main-checkout.js — the main checkout's one move to the worktree
 * model (workflow-core#4248).
 *
 *   node scripts/cutover-main-checkout.js
 *     cuts over the main checkout of the repository the current directory is
 *     in, from it or from any linked worktree of it; run again, it reports
 *     the edits left there and runs a levelling pass
 *
 * check-main-checkout-cutover.js runs the same cutover at session start
 * (lib/cutover-run.js, workflow-core#5276).
 *
 * In no family (§N3).
 *
 * The report goes to stderr. Exit 0 cut over, 1 refused or failed, 2 a usage
 * error.
 */

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
