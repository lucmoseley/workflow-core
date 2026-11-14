/*
 * review-tier-trailer.js — writes a held commit's `Review-Tier:` trailer, the
 * commit's own record of its sensitive-path review (#3664, spec #1612
 * §Disposition and records, Reach): its core. scripts/review-tier-trailer.js
 * is its entry, lib/review-tier-trailer-host.js its production ports. The
 * core does no I/O but through its ports, and returns the exit and the whole
 * of stderr.
 *
 * IMPLICIT, JUSTIFIED, DEFEAT and LIMITS: scripts/review-tier-trailer.js's
 * header.
 */

const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} TrailerPorts
 * @property {string} sessionId
 * @property {() => string} gitDir the absolute git directory, "" where git
 *   names none
 * @property {(gitDir: string) => string} route the commit route at
 *   prepare-commit-msg
 * @property {(msg: string) => string} readMessage throws where unreadable
 * @property {(msg: string, text: string) => void} writeMessage throws on a
 *   failed write
 * @property {(route: string) => string} vouching the one message whose
 *   `Review-Tier:` line this commit may keep, "" where none
 * @property {(gitDir: string) => string | null} stampPath null with no session
 * @property {(stamp: string) => string | null} readStamp null where absent,
 *   "" where unreadable
 * @property {(stamp: string) => void} removeStamp
 * @property {() => string} writeTree throws where git will not write it
 * @property {() => import("./review-hold.js").Outcome} hold the review hold,
 *   run on what the commit now carries
 * @property {(msg: string, value: string) => { ok: boolean, out: string }} interpretTrailers
 *   writes `Review-Tier: <value>` into the message, replacing any
 * @property {string} commitPaths how a reader runs commit-paths.js
 * @property {(what: string, detail?: string) => void} log the fail-open log
 */

/**
 * @typedef {object} Outcome
 * @property {number} status
 * @property {string} stderr
 */

const KEY = /^review-tier[ \t]*:/i;

/**
 * `msg` less each `Review-Tier:` line `vouching` does not carry, in any
 * spelling git reads as this key: any case, space before the colon, folded
 * lines. Null where nothing is removed.
 * @param {string} msg the message, as the file holds it
 * @param {string} vouching
 * @returns {string | null}
 */
function stripUnvouched(msg, vouching) {
	// Newlines only, as a shell's `$(…)` strips them, so this agrees with the shell copy (#5153).
	const vouched = new Set(trimEndRun(vouching, "\n").split("\n"));
	const lines = msg.split("\n");
	if (lines.at(-1) === "") lines.pop();
	/** @type {string[]} */
	const kept = [];
	let dropping = false;
	for (const line of lines) {
		if (KEY.test(line)) {
			dropping = !vouched.has(line);
			if (dropping) continue;
		} else if (dropping && /^[ \t]/.test(line)) continue;
		dropping = false;
		kept.push(line);
	}
	const keptText = trimEndRun(kept.join("\n"), "\n");
	return keptText === trimEndRun(msg, "\n") ? null : `${keptText}\n`;
}

class Stop extends Error {
	/** @param {number} status */
	constructor(status) {
		super(`stop ${status}`);
		this.status = status;
	}
}

/**
 * Runs the trailer over the message file `msg`.
 * @param {string} msg
 * @param {TrailerPorts} ports
 * @returns {Outcome}
 */
function runTrailer(msg, ports) {
	if (msg === "") return { status: 0, stderr: "" };
	/** @type {string[]} */
	const said = [];
	const state = { stripped: false, wrote: false };
	let status = 0;
	try {
		trail(msg, ports, said, state);
	} catch (e) {
		if (!(e instanceof Stop)) throw e;
		status = e.status;
	}
	if (status === 0 && state.stripped && !state.wrote)
		said.push(
			"prepare-commit-msg: removed the message's Review-Tier: line, as no review of this commit is recorded; only the review hold writes one.\n",
		);
	return { status, stderr: said.join("") };
}

/**
 * The fail-open sayings: each says why on stderr, logs it and stops at 0.
 * @param {TrailerPorts} ports
 * @param {string[]} said accumulator: each fail-open line is pushed here
 */
function failOpens(ports, said) {
	/** @param {string} saying @param {string} logged @param {string} [detail] @returns {never} */
	const failOpen = (saying, logged, detail) => {
		said.push(`prepare-commit-msg: ${saying}.\n`);
		ports.log(logged, detail);
		throw new Stop(0);
	};
	return {
		/** @param {string} why @param {string} [detail] @returns {never} */
		dropped: (why, detail) =>
			failOpen(
				`${why}, so this commit lands with no Review-Tier: trailer${detail ? ` (${detail})` : ""}`,
				`${why} — a held commit landed with no Review-Tier: trailer`,
				detail,
			),
		/** @param {string} why @returns {never} */
		unstripped: (why) =>
			failOpen(
				`${why}, so a Review-Tier: line in the message stands unvouched`,
				`${why} — a Review-Tier: line stands unvouched`,
			),
	};
}

/**
 * @param {string} msg
 * @param {TrailerPorts} ports
 * @param {string[]} said accumulator: each stderr line is pushed here
 * @param {{ stripped: boolean, wrote: boolean }} state accumulator: set to
 *   whether a line was stripped and whether a trailer was written
 */
function trail(msg, ports, said, state) {
	const { dropped, unstripped } = failOpens(ports, said);
	const gitDir = ports.gitDir();
	state.stripped = stripMessage(
		msg,
		ports,
		gitDir ? ports.route(gitDir) : "rebase",
		unstripped,
	);
	if (!gitDir)
		dropped("git named no git directory to read the review hold's stamp from");
	const stamp = ports.stampPath(gitDir);
	if (stamp === null) return;
	const value = settledValue(ports, stamp, said, dropped);
	if (value === null || value === "unheld") return;
	const wrote = ports.interpretTrailers(msg, value);
	if (!wrote.ok) dropped("git could not write the trailer", wrote.out);
	state.wrote = true;
}

/**
 * Strips the message's unvouched `Review-Tier:` lines; true where it removed
 * one.
 * @param {string} msg
 * @param {TrailerPorts} ports
 * @param {string} route
 * @param {(why: string) => never} unstripped
 */
function stripMessage(msg, ports, route, unstripped) {
	let text = "";
	try {
		text = ports.readMessage(msg);
	} catch {
		unstripped(`could not read the message file ${msg}`);
	}
	if (!text.split("\n").some((l) => KEY.test(l))) return false;
	const kept = stripUnvouched(text, ports.vouching(route));
	if (kept === null) return false;
	try {
		ports.writeMessage(msg, kept);
	} catch {
		unstripped(`could not rewrite the message file ${msg}`);
	}
	return true;
}

/**
 * The stamp's value once its tree is this commit's: where the tree moved,
 * the hold re-run on it, and the commit refused where that refuses or the
 * tree still differs. Null where there is no stamp, or the re-run hold left
 * none.
 * @param {TrailerPorts} ports
 * @param {string} stamp
 * @param {string[]} said accumulator: the hold's and the refusal's lines are pushed here
 * @param {(why: string) => never} dropped
 * @returns {string | null}
 */
function settledValue(ports, stamp, said, dropped) {
	let read = consume(ports, stamp);
	if (read === null) return null;
	let [recorded, value] = read;
	if (!(recorded && value))
		dropped(`the review hold's stamp ${stamp} could not be read`);
	let tree = "";
	try {
		tree = ports.writeTree();
	} catch {
		dropped("git could not read the staged tree");
	}
	if (recorded === tree) return value;
	const how = `prepare-commit-msg: the staged tree moved after the review hold passed, as another session staged into this index. Commit by pathspec, node ${ports.commitPaths} -m <message> -- <your paths>, which that index cannot reach (rule:review-hold). Nothing was committed.\n`;
	const held = ports.hold();
	said.push(held.stderr);
	if (held.status !== 0) {
		said.push(how);
		throw new Stop(held.status);
	}
	read = consume(ports, stamp);
	if (read === null) return null;
	[recorded, value] = read;
	if (recorded !== tree) {
		said.push(how);
		throw new Stop(1);
	}
	return value;
}

/**
 * The stamp's tree and value, consumed on read, so a stamp outliving its
 * commit stands behind no other; null where there is none. An unreadable
 * stamp reads as empty, which the caller reports.
 * @param {TrailerPorts} ports
 * @param {string} stamp
 * @returns {[string, string] | null}
 */
function consume(ports, stamp) {
	const text = ports.readStamp(stamp);
	if (text === null) return null;
	const lines = text.split("\n");
	ports.removeStamp(stamp);
	return [lines[0] ?? "", lines[1] ?? ""];
}

module.exports = { runTrailer };
