#!/usr/bin/env node

const { gh, parseErrLine } = require("./lib/gh");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { DRAIN_REACTION, fetchCaptures } = require("./lib/captures");
const { parseOrExit } = require("./lib/cli-args");

const USAGE =
	"usage: node capture-drain.js list [--all] [--json] | node capture-drain.js mark <comment-id>";

/** @param {string} msg @returns {never} */
function die(msg) {
	writeFd(2, `${msg}\n`);
	process.exit(1);
}

/** @param {{ all: boolean, json: boolean }} opts */
function list({ all, json }) {
	let captures;
	try {
		captures = fetchCaptures();
	} catch (e) {
		die(`could not read the tracker's comments: ${parseErrLine(e)}`);
	}
	const shown = all ? captures : captures.filter((c) => !c.drained);

	if (json) {
		writeFd(1, `${JSON.stringify(shown, null, 2)}\n`);
		return;
	}

	if (shown.length === 0) {
		writeFd(
			1,
			all
				? "No capture comments on the tracker at all.\n"
				: `No undrained captures — all ${captures.length} carry the :${DRAIN_REACTION}: reaction.\n`,
		);
		return;
	}

	writeFd(
		1,
		`${shown.length} capture(s), oldest first — of ${captures.length} on the tracker:\n\n`,
	);
	for (const c of shown) {
		const age = `${Math.floor(c.ageDays)}d`;
		const state = c.drained ? "drained" : "UNDRAINED";
		writeFd(
			1,
			`  [${c.id}] #${c.issue}  ${age}  ${state}\n    ${c.fact.replace(/\n/g, "\n    ")}\n    ${c.url}\n\n`,
		);
	}
	writeFd(
		1,
		`Mark one consumed once its fact is placed (or found already recorded):\n  node ${scriptPath("capture-drain.js")} mark <comment-id>\n`,
	);
}

/** @param {string[]} argv */
function mark(argv) {
	const ids = argv.filter((a) => /^\d+$/.test(a));
	if (ids.length !== 1)
		die(
			`mark takes exactly one numeric comment id${ids.length > 1 ? `, got ${ids.length}` : ""}.\n${USAGE}`,
		);
	const id = ids[0];
	try {
		gh([
			"api",
			"--method",
			"POST",
			`repos/{owner}/{repo}/issues/comments/${id}/reactions`,
			"-f",
			`content=${DRAIN_REACTION}`,
		]);
	} catch (e) {
		die(`could not react to comment ${id}: ${parseErrLine(e)}`);
	}
	writeFd(1, `Marked comment ${id} consumed (:${DRAIN_REACTION}:).\n`);
}

const { command, flags, positionals } = parseOrExit(process.argv.slice(2), {
	usage: USAGE,
	commands: {
		list: { usage: USAGE, flags: { "--all": "boolean", "--json": "boolean" } },
		mark: { usage: USAGE, max: Number.POSITIVE_INFINITY },
	},
});
if (command === "list")
	list({ all: "--all" in flags, json: "--json" in flags });
else mark(positionals);
