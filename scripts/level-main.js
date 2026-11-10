#!/usr/bin/env node
/*
 * level-main.js — one levelling pass over the main checkout (#4238): its
 * `main` fast-forwarded to `origin/main`, and `node_modules` rebuilt where the
 * lockfile changed. The pass itself is lib/level-main.js.
 *
 *   node scripts/level-main.js [--quiet]
 *     levels the main checkout of the repository the current directory is in,
 *     from it or from any linked worktree of it; `--quiet` prints nothing
 *     where main was already level, another pass held the lock or the
 *     checkout is not yet cut over (lib/cutover.js), and nothing failed —
 *     the refill loop's tick and the lander run it so
 *
 * In no family (§N3): it moves a branch and rebuilds a tree, so it is no
 * `check-*` gate, and it files nothing.
 *
 * The report goes to stderr (lib/level-main.js `buildReport`). Exit 0 level
 * or forwarded with the fetch and any install done, 1 anything else, 2 a
 * usage error.
 */

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
			/* The main checkout's write ledger, wherever this was run from. */
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
