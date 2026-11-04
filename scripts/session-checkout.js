#!/usr/bin/env node
/*
 * session-checkout.js — the command launchers and sessions call for a session
 * worktree (#4229); the lifecycle itself is lib/session-checkout.js.
 *
 *   node scripts/session-checkout.js cut <session-name>
 *     prints the new worktree's path on stdout
 *   node scripts/session-checkout.js launch-dir <prompt>
 *     prints the directory a session launched on <prompt> starts in: a
 *     worktree cut for it, or the main checkout where `landing` is off
 *   node scripts/session-checkout.js attach [<worktree>]
 *     re-points the worktree's node_modules at the store for its lockfile;
 *     the current directory's worktree where none is named
 *   node scripts/session-checkout.js land
 *     merges origin/landing into the current directory's worktree and pushes
 *     HEAD:landing, saying on stderr what it did; refused, it says why and
 *     what to do before landing again
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
const {
	attach,
	CheckoutError,
	cut,
	land,
	launchDir,
} = require("./lib/session-checkout.js");
const { writeFd } = require("./lib/write-fd.js");

const CLI = {
	usage:
		"usage: node scripts/session-checkout.js cut <session-name> | launch-dir <prompt> | attach [<worktree>] | land",
	commands: {
		cut: {
			usage: "usage: node scripts/session-checkout.js cut <session-name>",
			min: 1,
		},
		"launch-dir": {
			usage: "usage: node scripts/session-checkout.js launch-dir <prompt>",
			min: 1,
		},
		attach: {
			usage: "usage: node scripts/session-checkout.js attach [<worktree>]",
			max: 1,
		},
		land: {
			usage: "usage: node scripts/session-checkout.js land",
		},
	},
};

/**
 * Each command's run, saying what it did; a refusal throws.
 * @type {Record<string, (named: string | undefined) => void>}
 */
const RUN = {
	cut: (named) => {
		if (named === undefined) throw new Error("cut names no session");
		writeFd(1, `${cut(process.cwd(), named).dir}\n`);
	},
	"launch-dir": (named) => {
		if (named === undefined) throw new Error("launch-dir names no prompt");
		writeFd(1, `${launchDir(process.cwd(), named)}\n`);
	},
	attach: (named) => {
		const made = attach(path.resolve(named ?? process.cwd()));
		writeFd(
			2,
			made.store === null
				? `session checkout: ${made.dir} has no lockfile, so nothing is attached\n`
				: `session checkout: ${made.dir} uses ${made.store}${made.built ? ", built now" : ""}\n`,
		);
	},
	land: () => {
		const made = land(process.cwd());
		writeFd(
			2,
			made.pushed
				? `session checkout: pushed ${made.head} to landing${made.merged ? ", origin/landing merged in first" : ""}\n${made.lander}\n`
				: `session checkout: nothing to land — every commit of ${made.dir}'s HEAD is on origin/landing already\n`,
		);
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
		const command = RUN[String(parsed.command)];
		if (command === undefined)
			throw new Error(`no run for command ${parsed.command}`);
		command(parsed.positionals[0]);
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
