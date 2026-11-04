#!/usr/bin/env node
/*
 * level-main.js — one levelling pass over the main checkout (#4238): its
 * `main` fast-forwarded to `origin/main`, and `node_modules` rebuilt where the
 * lockfile changed. The pass itself is lib/level-main.js.
 *
 *   node scripts/level-main.js
 *     levels the main checkout of the repository the current directory is in,
 *     from it or from any linked worktree of it
 *
 * In no family (§N3): it moves a branch and rebuilds a tree, so it is no
 * `check-*` gate, and it files nothing.
 *
 * The report goes to stderr. Exit 0 level or forwarded with the fetch and any
 * install done, 1 anything else, 2 a usage error.
 */

const { caught } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { level, renderOutcome } = require("./lib/level-main.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const store = require("./lib/arbiter-store");
const { writeFd } = require("./lib/write-fd.js");

const CLI = { usage: "usage: node scripts/level-main.js" };

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
			lastWriter: (rel) => store.readLastWriterOf(rel, root),
			now: at,
		});
		writeFd(2, `${renderOutcome(outcome, at).join("\n")}\n`);
		const moved = outcome.status === "level" || outcome.status === "forwarded";
		return moved && outcome.fetchError === null && !outcome.install.error
			? 0
			: 1;
	} catch (err) {
		writeFd(2, `level main: failed: ${caught(err).message.trim()}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
