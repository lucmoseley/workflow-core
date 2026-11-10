/*
 * dispatch-gates.js — dispatch-sessions.sh's seat, key and auth gates in one
 * node start (workflow-core#4321). Each gate keeps its own module and its own refusal; this
 * file only runs them in the script's order.
 *
 *   node scripts/lib/dispatch-gates.js -- <config dir> [<key var>]
 *
 * Prints `<seat kind> <burn>` — `plan` or `overflow` (lib/refill-seats.js),
 * then `on` where burn mode's marker exists (lib/burn-mode.js) — a second
 * line: the variables every launch's environment drops, and a third: the
 * seat's label (lib/refill-seats.js's buildSeatLabel), which the dispatcher's
 * lines name it by. The variables dropped are the launcher's root
 * (lib/inherited-roots.js) and, on an overflow seat, those
 * lib/overflow-key.js's buildOverflowLaunch names, any key among them, so the
 * key reaches the child through that file's helper alone, which
 * lib/headless-sessions.js passes in `--settings`. Exits 0. Exits 2 printing `REFUSED:` and why where
 * the seat file refuses the seat, the overflow key cannot be read, or the
 * launch would bill other than its seat (lib/launch-auth.js), judged in the
 * environment the launch hands its child.
 *
 * The duplicate gate and the kernel check stay their own starts: each runs
 * under lib/check.js's runCheck, which owns its process's exit.
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { markerPath } = require("./burn-mode.js");
const { caught } = require("./caught.js");
const { claudeBin } = require("./claude-bin.js");
const { ROOT_VARS } = require("./inherited-roots.js");
const { launchAuthRefusal } = require("./launch-auth.js");
const { buildOverflowLaunch } = require("./overflow-key.js");
const {
	buildSeatLabel,
	readDeclaredSeats,
	seatOfLaunch,
} = require("./refill-seats.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

/**
 * Fails open (workflow-core#4321): burn mode only remaps a model.
 * @returns {"on" | "off"}
 */
function readBurnMode() {
	let marker;
	try {
		marker = markerPath();
	} catch {
		writeFd(
			2,
			"WARNING: burn-mode marker path unresolved — launching as if burn mode were off\n",
		);
		return "off";
	}
	try {
		return fs.statSync(marker, { throwIfNoEntry: false })?.isFile()
			? "on"
			: "off";
	} catch {
		return "off";
	}
}

/**
 * @param {string} dir
 * @param {string | undefined} keyVar
 * @returns {{kind: "plan" | "overflow", label: string,
 *   overflow?: {settings: string, unset: string[]}} | {why: string}}
 *   the seat's kind and label and an overflow launch's settings and dropped
 *   variables, or the refusal of the first gate that refuses, ending in a
 *   newline
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
	let env = process.env;
	/** @type {{settings: string, unset: string[]} | undefined} */
	let overflow;
	if (seat.kind === "overflow") {
		const built = buildOverflowLaunch(seat.keyVar, env);
		if ("why" in built)
			return { why: `overflow seat ${buildSeatLabel(seat)}: ${built.why}\n` };
		({ env } = built);
		overflow = { settings: built.settings, unset: built.unset };
	}
	const auth = launchAuthRefusal({
		bin: claudeBin(env),
		env,
		cwd: process.cwd(),
		settings: overflow?.settings,
	});
	if (auth) return { why: `${auth}\n` };
	return { kind: seat.kind, label: buildSeatLabel(seat), overflow };
}

/** @returns {never} */
function usage() {
	writeFd(
		2,
		`usage: node ${scriptPath("lib/dispatch-gates.js")} -- <config dir> [<key var>]\n`,
	);
	process.exit(2);
}

/** @returns {[string, string | undefined]} the config dir and key var */
function readArgs() {
	let positionals = /** @type {string[]} */ ([]);
	try {
		({ positionals } = parseArgs({ allowPositionals: true, strict: true }));
	} catch {
		// An unknown option is a usage error, said below like a missing dir.
	}
	const [dir, keyVar, ...rest] = positionals;
	if (!dir || rest.length > 0) return usage();
	return [dir, keyVar];
}

if (require.main === module) {
	const [dir, keyVar] = readArgs();
	let outcome;
	try {
		outcome = gateOutcome(dir, keyVar || undefined);
	} catch (err) {
		outcome = {
			why: `the dispatch gates could not run (seat ${dir}):\n${caught(err)
				.message.split("\n")
				.map((l) => `  ${l}\n`)
				.join("")}`,
		};
	}
	if ("why" in outcome) {
		writeFd(2, `REFUSED: ${outcome.why}`);
		process.exit(2);
	}
	writeFd(1, `${outcome.kind} ${readBurnMode()}\n`);
	const unset = [...ROOT_VARS, ...(outcome.overflow?.unset ?? [])];
	writeFd(1, `${unset.join(" ")}\n${outcome.label}\n`);
}
