#!/usr/bin/env node
/*
 * session-checkout.js — the command launchers and sessions call for a session
 * worktree (#4229); the lifecycle itself is lib/session-checkout.js.
 *
 *   node scripts/session-checkout.js cut <session-name>
 *     prints the new worktree's path on stdout
 *   node scripts/session-checkout.js attach [<worktree>]
 *     re-points the worktree's node_modules at the store for its lockfile;
 *     the current directory's worktree where none is named
 *
 * Exit 0 done, 1 refused or failed (why on stderr), 2 a usage error.
 *
 * IT JOINS NO FAMILY (§G4, §N3): it gates nothing (no `check-*`), no hook
 * runs it (no `guard-*`), it generates no file (no `generate-*`) and files no
 * issue (no `report-*`).
 */

const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { attach, CheckoutError, cut } = require("./lib/session-checkout.js");
const { writeFd } = require("./lib/write-fd.js");

const CLI = {
	usage:
		"usage: node scripts/session-checkout.js cut <session-name> | attach [<worktree>]",
	commands: {
		cut: {
			usage: "usage: node scripts/session-checkout.js cut <session-name>",
			min: 1,
		},
		attach: {
			usage: "usage: node scripts/session-checkout.js attach [<worktree>]",
			max: 1,
		},
	},
};

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	try {
		const [named] = parsed.positionals;
		if (parsed.command === "cut" && named !== undefined) {
			const made = cut(process.cwd(), named);
			writeFd(1, `${made.dir}\n`);
			return 0;
		}
		const dir = path.resolve(named ?? process.cwd());
		const made = attach(dir);
		writeFd(
			2,
			made.store === null
				? `session checkout: ${made.dir} has no lockfile, so nothing is attached\n`
				: `session checkout: ${made.dir} uses ${made.store}${made.built ? ", built now" : ""}\n`,
		);
		return 0;
	} catch (err) {
		const why = caught(err).message.trim();
		writeFd(
			2,
			`session checkout: ${err instanceof CheckoutError ? why : `failed: ${why}`}\n`,
		);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
