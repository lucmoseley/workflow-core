#!/usr/bin/env node
/*
 * steps-owed.js — CLI over lib/steps-owed.js: the only writer of
 * `.claude/workflow-core.json`'s `stepsOwed` field outside `upgrade.js`
 * (the walker, workflow-core#248). A session works an `act` itself, puts a `choice` to
 * the founder, or prints a `notice` once — then discharges the entry here
 * rather than hand-editing the committed file.
 *
 * Usage:
 *   node scripts/steps-owed.js list
 *   node scripts/steps-owed.js clear   <tag> <act|choice|notice> "<text>"
 *   node scripts/steps-owed.js decline <tag> "<text>"
 *
 * `<tag>` and `<text>` must match the entry exactly, as `list` prints them.
 * `decline` only ever touches a `choice` — it stays in the field marked
 * `declined: true`, never re-surfaced by the reporter but never re-asked
 * either; an `act` or a `notice` is `clear`ed once discharged, `decline`
 * refusing to touch either.
 */

const { writeFd } = require("./lib/write-fd.js");
const { parseOrCode } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const {
	readStepsOwed,
	clearStepOwed,
	declineStepOwed,
} = require("./lib/steps-owed.js");
const { caught } = require("./lib/caught.js");

const USAGE =
	'usage: steps-owed.js list | clear <tag> <act|choice|notice> "<text>" | decline <tag> "<text>"';

const CLI = {
	usage: USAGE,
	commands: {
		list: { usage: "usage: steps-owed.js list" },
		clear: {
			usage: 'usage: steps-owed.js clear <tag> <act|choice|notice> "<text>"',
			min: 3,
		},
		decline: { usage: 'usage: steps-owed.js decline <tag> "<text>"', min: 2 },
	},
};

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const { command: cmd, positionals: rest } = parsed;
	const root = hostRoot();

	if (cmd === "list") {
		writeFd(1, `${JSON.stringify(readStepsOwed(root), null, "\t")}\n`);
		return 0;
	}

	if (cmd === "clear") return runClear(root, rest);
	if (cmd === "decline") return runDecline(root, rest);

	throw new Error(`parse let through an unhandled command: ${cmd}`);
}

/**
 * @param {string} root
 * @param {string[]} rest
 * @returns {number}
 */
function runClear(root, rest) {
	const [tag, type, text] = rest;
	if (tag === undefined || type === undefined || text === undefined)
		throw new Error("parse passed clear too few arguments despite min: 3");
	try {
		const ok = clearStepOwed(root, { tag, type, text });
		writeFd(1, ok ? `cleared ${tag} [${type}]\n` : "no matching entry\n");
		return ok ? 0 : 1;
	} catch (err) {
		writeFd(2, `steps-owed: ${caught(err).message}\n`);
		return 2;
	}
}

/**
 * @param {string} root
 * @param {string[]} rest
 * @returns {number}
 */
function runDecline(root, rest) {
	const [tag, text] = rest;
	if (tag === undefined || text === undefined)
		throw new Error("parse passed decline too few arguments despite min: 2");
	try {
		const ok = declineStepOwed(root, { tag, text });
		writeFd(1, ok ? `declined ${tag} [choice]\n` : "no matching entry\n");
		return ok ? 0 : 1;
	} catch (err) {
		writeFd(2, `steps-owed: ${caught(err).message}\n`);
		return 2;
	}
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
