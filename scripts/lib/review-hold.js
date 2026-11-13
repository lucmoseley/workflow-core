/*
 * review-hold.js — the pre-commit hold on a declared sensitive path (#1622,
 * spec #1612 §The hold): its core. scripts/review-hold-gate.js is its entry,
 * lib/review-hold-host.js its production ports, git over the committing
 * repo. The core does no I/O but through its ports, and returns the exit and
 * the whole of stderr.
 *
 * IMPLICIT, JUSTIFIED, DEFEAT and LIMITS: scripts/review-hold-gate.js's
 * header.
 */

const { stripNewlines } = require("./strip-newlines.js");

const NAMED_PATHS_MAX = 10;

/** One stderr line's details are cut to this, as guard-log.sh cuts them. */
const DETAIL_MAX = 300;

/**
 * @typedef {object} HoldPorts
 * @property {string} sessionId CLAUDE_CODE_SESSION_ID, empty in the founder's
 *   own terminal
 * @property {string} pluginRoot WFC_PLUGIN_ROOT, empty in a checkout
 * @property {() => string} gitDir the absolute git directory; throws where git
 *   will not name it
 * @property {(gitDir: string) => string} route the commit route at pre-commit
 * @property {(gitDir: string) => string | null} stampPath this session's
 *   stamp, null with no session
 * @property {(stamp: string) => void} removeStamp throws where it stays
 * @property {(gitDir: string) => void} sweepStamps throws where it fails
 * @property {() => string[]} stagedPaths every path the commit changes,
 *   renames read as a delete and an add
 * @property {() => string} writeTree the tree the commit carries
 * @property {(paths: string[]) => string[]} unreplayed of `paths`, those whose
 *   staged change is not the one CHERRY_PICK_HEAD made; throws where it
 *   cannot compare
 * @property {(paths: string[], gitDir: string) => string[]} offMergedSides of
 *   `paths`, those whose staged bytes are no merged-in side's, all of them
 *   where the sides cannot be read; throws where it cannot compare
 * @property {(paths: string[]) => { judged: boolean, areas: string[], fault: string }} heldAreas
 *   lib/sensitive-paths.js's heldAreas over HEAD's and the staged declaration
 * @property {() => string} markerPath this session's `.codereview-pass-<sid>`;
 *   throws where the markers directory will not resolve
 * @property {(marker: string) => string | null} readMarker null where absent
 * @property {(stamp: string, text: string) => void} writeStamp throws on a
 *   failed write
 * @property {(stamp: string) => void} dropStamp removes it, never throwing
 * @property {(id: string) => string | null} ruleText null where unreadable
 * @property {(what: string, detail?: string) => void} log the fail-open log
 */

/**
 * @typedef {object} Outcome
 * @property {0 | 1} status
 * @property {string} stderr
 */

class Unchecked extends Error {
	/**
	 * @param {string} what
	 * @param {{ detail?: string, cause?: unknown }} [opts]
	 */
	constructor(what, { detail, cause } = {}) {
		super(what, { cause });
		this.detail = detail;
	}
}

/**
 * The value of the marker's first `<key>=` line, verbatim, or null where it
 * has none.
 * @param {string} text
 * @param {string} key
 */
function markerField(text, key) {
	const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
	return line === undefined ? null : line.slice(key.length + 1);
}

/** @param {string | null} v */
const stripped = (v) => (v ?? "").replace(/\s/g, "");

/**
 * The comma-separated values of the marker's `<key>=` line, trimmed, empty
 * ones dropped.
 * @param {string} text
 * @param {string} key
 */
const markerList = (text, key) =>
	(markerField(text, key) ?? "")
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v !== "");

/** @param {string[]} words */
const joinComma = (words) => words.join(", ");

/** @param {string} v */
const shortQuote = (v) => `'${v.slice(0, 40)}'`;

/**
 * Why the marker does not clear a commit holding `areas`, carrying `tree` and
 * owing review of `owed`, or "" where it does: an escalated tier naming every
 * area, `tree=` this tree, and `paths=` naming every owed path.
 * @param {string | null} text the marker, null where there is none
 * @param {string[]} areas
 * @param {string} tree
 * @param {string[]} owed
 */
function markerFault(text, areas, tree, owed) {
	if (text === null) return "there is no marker";
	const tier = stripped(markerField(text, "tier"));
	if (tier === "") return "it has no tier= line";
	if (tier !== "escalated" && tier !== "mission-critical")
		return `its tier= is ${shortQuote(tier)}, and only escalated or mission-critical covers a declared sensitive path`;
	const named = new Set(markerList(text, "areas"));
	const missing = areas.filter((a) => !named.has(a));
	if (missing.length > 0)
		return `its areas= does not name ${joinComma(missing)}`;
	const recorded = stripped(markerField(text, "tree"));
	if (recorded === "") return "it has no tree= line";
	if (recorded !== tree)
		return "its tree= is not the tree this commit carries, so something changed after it was written";
	if (markerField(text, "paths") === null) return "it has no paths= line";
	const paths = markerList(text, "paths");
	if (paths.length === 0) return "its paths= names no path";
	const listed = new Set(paths);
	const unnamed = owed.filter((p) => !listed.has(p));
	if (unnamed.length > 0)
		return `its paths= does not name ${joinComma(unnamed.slice(0, NAMED_PATHS_MAX))}`;
	return "";
}

/**
 * The `Review-Tier:` value a clearing marker leaves for the trailer.
 * @param {string} text
 * @param {string} tree
 */
const stampValue = (text, tree) =>
	`${stripped(markerField(text, "tier"))}; areas=${markerList(text, "areas").join(",")}; base=${stripped(markerField(text, "base"))}; tree=${tree}; paths=${markerList(text, "paths").join(",")}`;

/**
 * The refusal, every line of it.
 * @param {object} r
 * @param {string[]} r.areas
 * @param {string[] | null} r.offSides on a merge, the paths no side carries
 * @param {string} r.marker
 * @param {string} r.fault
 * @param {string} r.stagedFault the staged declaration's read fault, or ""
 * @param {string | null} r.rule the rule's text, null where unreadable
 */
function refusal({ areas, offSides, marker, fault, stagedFault, rule }) {
	const lines = [
		"pre-commit: this commit changes a declared sensitive path, and no escalated review of exactly this change is recorded (#1622).",
		`  Areas touched: ${joinComma(areas)}.`,
	];
	if (offSides)
		lines.push(
			`  This merge's paths no merged-in side carries, the ones to review: ${joinComma(offSides)}.`,
		);
	lines.push(`  The marker ${marker} does not clear it: ${fault}.`);
	if (stagedFault)
		lines.push(
			`  The staged .claude/workflow-core.json will not read, and a review would land it broken, so correct it first: ${stagedFault}`,
		);
	if (rule === null)
		lines.push(
			"  The rule itself could not be read from docs/agents/rules/review-hold.txt. Restore that file from origin/main, or revert the change that removed it, then read it before going on.",
		);
	else lines.push("", stripNewlines(rule), "");
	lines.push(
		"pre-commit: the review hold refused this commit (rule:review-hold). Nothing was committed.",
	);
	return `${lines.join("\n")}\n`;
}

/**
 * Runs the hold over the commit the ports read.
 * @param {HoldPorts} ports
 * @returns {Outcome}
 */
function runHold(ports) {
	if (!ports.sessionId) return { status: 0, stderr: "" };
	/** @type {string[]} */
	const said = [];
	try {
		return judge(ports, said);
	} catch (e) {
		if (!(e instanceof Unchecked)) throw e;
		const detail = e.detail ? e.detail.slice(0, DETAIL_MAX) : "";
		said.push(
			`pre-commit: the review hold ${e.message}${detail ? ` (${detail})` : ""} — this commit is NOT checked. See: node ${ports.pluginRoot ? `${ports.pluginRoot}/` : ""}scripts/check-guard-errors.js\n`,
		);
		ports.log(
			`${e.message} — a commit went unchecked for a sensitive-path review`,
			detail,
		);
		return { status: 0, stderr: said.join("") };
	}
}

/**
 * @template T
 * @param {() => T} read
 * @param {string} what
 * @returns {T}
 */
function orUnchecked(read, what) {
	try {
		return read();
	} catch (e) {
		throw new Unchecked(what, { cause: e });
	}
}

/**
 * @param {HoldPorts} ports
 * @param {string[]} said stderr so far
 * @returns {Outcome}
 */
function judge(ports, said) {
	const gitDir = orUnchecked(ports.gitDir, "could not read the git directory");
	const stamp = clearStamp(ports, gitDir);
	const route = ports.route(gitDir);
	const paths = orUnchecked(
		ports.stagedPaths,
		"could not list the staged paths",
	);
	const tree = orUnchecked(ports.writeTree, "could not read the staged tree");
	/** @param {string} value @param {string} lost */
	const pass = (value, lost) => {
		if (stamp !== null)
			writeStamp(ports, { stamp, text: `${tree}\n${value}\n`, lost }, said);
		return { status: /** @type {0} */ (0), stderr: said.join("") };
	};
	const unheld = () =>
		pass("unheld", "no check that its tree stayed put under the later gates");
	if (paths.length === 0) return unheld();
	let held = paths;
	let owed = paths;
	if (route === "cherry-pick")
		held = orUnchecked(
			() => ports.unreplayed(paths),
			"could not compare the staged change with the picked commit's",
		);
	else if (route === "merge") {
		held = orUnchecked(
			() => ports.offMergedSides(paths, gitDir),
			"could not compare the staged bytes with the merged-in sides'",
		);
		owed = held;
	}
	if (held.length === 0) return unheld();
	let read;
	try {
		read = ports.heldAreas(held);
	} catch (e) {
		throw new Unchecked(
			"could not match the staged paths against sensitivePaths",
			{ detail: e instanceof Error ? e.message : String(e), cause: e },
		);
	}
	if (!read.judged)
		throw new Unchecked(
			"could not match the staged paths against sensitivePaths",
			{ detail: read.fault },
		);
	if (read.areas.length === 0) return unheld();
	const marker = orUnchecked(
		ports.markerPath,
		"could not resolve the markers directory",
	);
	const text = ports.readMarker(marker);
	const fault = markerFault(text, read.areas, tree, owed);
	if (fault === "" && text !== null)
		return pass(stampValue(text, tree), "no Review-Tier: trailer");
	said.push(
		refusal({
			areas: read.areas,
			offSides: route === "merge" ? held : null,
			marker,
			fault,
			stagedFault: read.fault,
			rule: ports.ruleText("review-hold"),
		}),
	);
	return { status: 1, stderr: said.join("") };
}

/**
 * Removes this session's stamp, so a stamp a later gate's refusal stranded
 * stands behind no commit the hold does not pass, and sweeps dead sessions'.
 * @param {HoldPorts} ports
 * @param {string} gitDir
 */
function clearStamp(ports, gitDir) {
	const stamp = ports.stampPath(gitDir);
	if (stamp !== null)
		try {
			ports.removeStamp(stamp);
		} catch {
			ports.log(
				`could not remove ${stamp} — a stranded stamp may stand behind this commit`,
			);
		}
	try {
		ports.sweepStamps(gitDir);
	} catch {
		ports.log(`could not sweep ${gitDir}'s dead sessions' review-tier stamps`);
	}
	return stamp;
}

/**
 * Writes the stamp; a stamp unwritten costs `lost`, never the pass.
 * @param {HoldPorts} ports
 * @param {{ stamp: string, text: string, lost: string }} write
 * @param {string[]} said
 */
function writeStamp(ports, { stamp, text, lost }, said) {
	try {
		ports.writeStamp(stamp, text);
	} catch {
		ports.dropStamp(stamp);
		said.push(
			`pre-commit: could not write ${stamp}, so this commit lands with ${lost}.\n`,
		);
		ports.log(`could not write ${stamp} — a commit lands with ${lost}`);
	}
}

module.exports = { runHold, markerFault, stampValue, refusal, NAMED_PATHS_MAX };
