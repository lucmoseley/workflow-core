#!/usr/bin/env node
/*
 * capture-drain.js — the machinery under the `capture-drain` skill: it finds
 * capture comments and marks one consumed. Every judgement the drain makes —
 * which document owns the fact, whether the repo already records it, whether to
 * skip it — belongs to the skill, and none of it is here.
 *
 * Usage:
 *   node capture-drain.js list [--all] [--json]
 *   node capture-drain.js mark <comment-id>
 *
 * `list` prints the undrained captures oldest first, which is drain order;
 * `--all` adds the drained ones. `mark` puts the consumed reaction on one
 * comment. A capture the drain deliberately SKIPS is never marked, so it stays
 * visibly undrained rather than being swept past (mantahostels#679).
 *
 * Marking is a reaction, never an edit to the comment text: a body edit is the
 * download-whole/upload-whole shape that loses a parallel session's writes
 * (mantahostels#640, on mantahostels#128's measurement).
 *
 * Exit codes: 0 on success, 2 on an unknown command, flag or argument, 1 on any
 * other bad invocation or a failed call. This is a
 * driven tool, not a member of the check-*.js family, so it has no SKIP/BROKEN
 * alphabet — the checker beside it, check-capture-drain.js, does.
 */

const { gh, errLine } = require("./lib/gh");
const { DRAIN_REACTION, fetchCaptures } = require("./lib/captures");
const { parseOrExit } = require("./lib/cli-args");

const USAGE =
	"usage: node capture-drain.js list [--all] [--json] | node capture-drain.js mark <comment-id>";

/** @param {string} msg @returns {never} */
const die = (msg) => {
	process.stderr.write(`${msg}\n`);
	process.exit(1);
};

/** @param {{ all: boolean, json: boolean }} opts */
function list({ all, json }) {
	let captures;
	try {
		captures = fetchCaptures();
	} catch (e) {
		die(`could not read the tracker's comments: ${errLine(e)}`);
	}
	const shown = all ? captures : captures.filter((c) => !c.drained);

	if (json) {
		process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
		return;
	}

	if (shown.length === 0) {
		process.stdout.write(
			all
				? "No capture comments on the tracker at all.\n"
				: `No undrained captures — all ${captures.length} carry the :${DRAIN_REACTION}: reaction.\n`,
		);
		return;
	}

	process.stdout.write(
		`${shown.length} capture(s), oldest first — of ${captures.length} on the tracker:\n\n`,
	);
	for (const c of shown) {
		const age = `${Math.floor(c.ageDays)}d`;
		const state = c.drained ? "drained" : "UNDRAINED";
		process.stdout.write(
			`  [${c.id}] #${c.issue}  ${age}  ${state}\n    ${c.fact.replace(/\n/g, "\n    ")}\n    ${c.url}\n\n`,
		);
	}
	process.stdout.write(
		"Mark one consumed once its fact is placed (or found already recorded):\n  node scripts/capture-drain.js mark <comment-id>\n",
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
		die(`could not react to comment ${id}: ${errLine(e)}`);
	}
	process.stdout.write(
		`Marked comment ${id} consumed (:${DRAIN_REACTION}:).\n`,
	);
}

const { command, flags, positionals } = parseOrExit(process.argv.slice(2), {
	usage: USAGE,
	commands: {
		list: { usage: USAGE, flags: { "--all": "boolean", "--json": "boolean" } },
		// mark counts its own ids, so its refusal can say how many it got.
		mark: { usage: USAGE, max: Number.POSITIVE_INFINITY },
	},
});
if (command === "list")
	list({ all: "--all" in flags, json: "--json" in flags });
else mark(positionals);
