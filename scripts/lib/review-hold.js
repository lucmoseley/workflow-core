const { markerFault, refusal, stampValue } = require("./review-hold-marker.js");

// #5153
const DETAIL_MAX = 300;

/**
 * @typedef {object} HoldPorts
 * @property {string} sessionId
 * @property {string} pluginRoot
 * @property {() => string} gitDir
 * @property {(gitDir: string) => string} route
 * @property {(gitDir: string) => string | null} stampPath
 * @property {(stamp: string) => void} removeStamp
 * @property {(gitDir: string) => void} sweepStamps
 * @property {() => string[]} stagedPaths
 * @property {() => string} writeTree
 * @property {(paths: string[]) => string[]} unreplayed
 * @property {(paths: string[], gitDir: string) => string[]} offMergedSides
 * @property {(paths: string[]) => { judged: boolean, areas: string[], fault: string }} heldAreas
 * @property {() => string} markerPath
 * @property {(marker: string) => string | null} readMarker
 * @property {(stamp: string, text: string) => void} writeStamp
 * @property {(stamp: string) => void} dropStamp
 * @property {() => string} ruleText
 * @property {(what: string, detail?: string) => void} log
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
 * @param {string[]} said
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
			rule: ports.ruleText(),
		}),
	);
	return { status: 1, stderr: said.join("") };
}

/**
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

module.exports = { runHold };
