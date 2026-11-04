/*
 * dispatch-gates.js — dispatch-sessions.sh's seat and auth gates in one node
 * start (#4321). Each gate keeps its own module and its own refusal; this file
 * only runs them in the script's order.
 *
 *   node scripts/lib/dispatch-gates.js -- <config dir> [<key var>]
 *
 * Prints `<seat kind> <burn>` — `plan` or `overflow` (lib/refill-seats.js),
 * then `on` where burn mode's marker exists (lib/burn-mode.js) — and exits 0.
 * Exits 2 printing `REFUSED:` and why where the seat file refuses the seat, or,
 * on a plan seat, where its launch would bill per token (lib/launch-auth.js;
 * the headless overflow launcher checks its own).
 *
 * The duplicate gate and the kernel check stay their own starts: each runs
 * under lib/check.js's runCheck, which owns its process's exit.
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { markerPath } = require("./burn-mode.js");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { readDeclaredSeats, seatOfLaunch } = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

/**
 * Fails open (#4321): burn mode only remaps a model.
 * @returns {"on" | "off"}
 */
function readBurnMode() {
	try {
		return fs.statSync(markerPath(), { throwIfNoEntry: false })?.isFile()
			? "on"
			: "off";
	} catch {
		writeFd(
			2,
			"WARNING: burn-mode marker path unresolved — launching as if burn mode were off\n",
		);
		return "off";
	}
}

/**
 * @param {string} dir
 * @param {string | undefined} keyVar
 * @returns {{kind: "plan" | "overflow"} | {why: string}} the seat's kind, or
 *   the refusal of the first gate that refuses, ending in a newline
 */
function gateOutcome(dir, keyVar) {
	const list = readDeclaredSeats();
	const seat =
		list.errors.length > 0 ? null : seatOfLaunch(list, { dir, keyVar });
	if (!seat || "why" in seat) {
		const why = seat ? [seat.why] : list.errors;
		return {
			why: `the seat file refuses (seat ${dir}):\n${why.map((w) => `  ${w}\n`).join("")}`,
		};
	}
	if (seat.kind === "plan") {
		const auth = launchAuthRefusal({
			bin: claudeBin(),
			env: process.env,
			cwd: process.cwd(),
		});
		if (auth) return { why: `${auth}\n` };
	}
	return { kind: seat.kind };
}

/** @returns {never} */
function usage() {
	writeFd(
		2,
		`usage: node ${scriptPath("lib/dispatch-gates.js")} -- <config dir> [<key var>]\n`,
	);
	process.exit(2);
}

/** @returns {string[]} */
function readArgs() {
	let positionals = /** @type {string[]} */ ([]);
	try {
		({ positionals } = parseArgs({ allowPositionals: true, strict: true }));
	} catch {
		// An unknown option is a usage error, said below like a missing dir.
	}
	if (positionals.length === 0 || positionals.length > 2) usage();
	return positionals;
}

if (require.main === module) {
	const [dir, keyVar] = readArgs();
	let outcome;
	try {
		outcome = gateOutcome(dir, keyVar || undefined);
	} catch (err) {
		outcome = {
			why: `the dispatch gates could not run (seat ${dir}):\n  ${caught(err).message}\n`,
		};
	}
	if ("why" in outcome) {
		writeFd(2, `REFUSED: ${outcome.why}`);
		process.exit(2);
	}
	writeFd(1, `${outcome.kind} ${readBurnMode()}\n`);
}
