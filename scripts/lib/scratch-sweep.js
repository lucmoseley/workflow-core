const fs = require("node:fs");
const path = require("node:path");
const { caught, ignoreFailure } = require("./caught.js");

// guess, lucmoseley/mantahostels#2090
const SCRATCH_AGE_MS = 24 * 60 * 60 * 1000;
// guess: a research artefact may await landing, lucmoseley/mantahostels#2090
const RESEARCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESEARCH_WORD = "research";
const AGENTS_DIR = "agents";

const EXEMPT_TOP_LEVEL = new Set(["markers", "attachments"]);

/**
 * @param {string} rel
 * @returns {number}
 */
const floorFor = (rel) => {
	const segments = rel.split(path.sep);
	return segments[0] === AGENTS_DIR ||
		segments.some((s) => s.includes(RESEARCH_WORD))
		? RESEARCH_AGE_MS
		: SCRATCH_AGE_MS;
};

/**
 * @param {string} dir
 * @returns {{ entries: import("node:fs").Dirent[]|null, fault: string|null }}
 */
function readEntriesOf(dir) {
	try {
		return {
			entries: fs.readdirSync(dir, { withFileTypes: true }),
			fault: null,
		};
	} catch (e) {
		const { code, message } = caught(e);
		const fault = code === "ENOENT" ? null : `${dir}: ${code || message}`;
		return { entries: null, fault };
	}
}

/**
 * @param {string} full
 * @param {{follow?: boolean}} [opts]
 * @returns {number|null}
 */
function writtenAtMs(full, { follow = false } = {}) {
	let st;
	try {
		st = follow ? fs.statSync(full) : fs.lstatSync(full);
	} catch {
		return null;
	}
	if (process.env.WFC_SCRATCH_AGE_MTIME_ONLY === "1") return st.mtimeMs;
	return Math.max(st.mtimeMs, st.ctimeMs);
}

/**
 * @param {string} dir
 * @param {number} now
 * @param {(full: string) => number|null} [timeOf]
 * @param {string} [rel]
 * @returns {boolean}
 */
function hasAgedCandidate(dir, now, timeOf = writtenAtMs, rel = "") {
	const { entries } = readEntriesOf(dir);
	if (!entries) return false;
	for (const e of entries) {
		const full = path.join(dir, e.name);
		const relOf = path.join(rel, e.name);
		if (e.isDirectory()) {
			if (isAgedDirectory(full, now, timeOf, relOf)) return true;
		} else if (
			(e.isFile() || e.isSymbolicLink()) &&
			isPastFloor(full, now, timeOf, relOf)
		)
			return true;
	}
	return false;
}

/**
 * @param {string} full
 * @param {number} now
 * @param {(full: string) => number|null} timeOf
 * @param {string} relOf
 * @returns {boolean}
 */
function isAgedDirectory(full, now, timeOf, relOf) {
	if (hasAgedCandidate(full, now, timeOf, relOf)) return true;
	const inside = readEntriesOf(full).entries;
	if (inside === null || inside.length > 0) return false;
	return isPastFloor(full, now, timeOf, relOf);
}

/**
 * @param {string} full
 * @param {number} now
 * @param {(full: string) => number|null} timeOf
 * @param {string} relOf
 * @returns {boolean}
 */
function isPastFloor(full, now, timeOf, relOf) {
	const writtenMs = timeOf(full);
	return writtenMs !== null && now - writtenMs > floorFor(relOf);
}

/**
 * @param {{startedAt?: unknown}[]} agents
 * @returns {number}
 */
function earliestStart(agents) {
	if (agents.length === 0) return Number.NEGATIVE_INFINITY;
	let earliest = Number.POSITIVE_INFINITY;
	for (const a of agents) {
		const t = Number(a?.startedAt);
		if (!Number.isFinite(t)) return Number.NEGATIVE_INFINITY;
		if (t < earliest) earliest = t;
	}
	return earliest;
}

/**
 * @typedef {object} SweepState
 * @property {number} now
 * @property {number} earliest
 * @property {string[]} deleted
 * @property {string[]} failed
 * @property {(full: string) => number|null} timeOf
 */

/**
 * @param {string} dir
 * @param {SweepState} sweep
 * @param {object} [level]
 * @param {Set<string>} [level.exemptNames]
 * @param {string} [level.rel]
 */
function sweepDir(dir, sweep, { exemptNames, rel = "" } = {}) {
	const { entries, fault } = readEntriesOf(dir);
	if (fault) sweep.failed.push(fault);
	if (!entries) return;
	for (const e of entries) {
		if (exemptNames?.has(e.name)) continue;
		if (!e.isDirectory() && !e.isFile() && !e.isSymbolicLink()) continue;
		sweepEntry(
			path.join(dir, e.name),
			path.join(rel, e.name),
			e.isDirectory(),
			sweep,
		);
	}
}

/**
 * @param {string} full
 * @param {string} relOf
 * @param {boolean} isDir
 * @param {SweepState} sweep
 * @returns {void}
 */
function sweepEntry(full, relOf, isDir, sweep) {
	const { now, earliest, timeOf } = sweep;
	const writtenMs = timeOf(full);
	if (writtenMs === null) return;
	const condemned = now - writtenMs > floorFor(relOf) && earliest >= writtenMs;
	if (!isDir) {
		if (condemned) removeFile(full, sweep);
		return;
	}
	sweepDir(full, sweep, { rel: relOf });
	if (condemned) removeDirectory(full, sweep);
}

/**
 * @param {string} full
 * @param {SweepState} sweep
 * @returns {void}
 */
function removeDirectory(full, { deleted, failed }) {
	try {
		fs.rmdirSync(full);
		deleted.push(full);
	} catch (e2) {
		const { code, message } = caught(e2);
		if (code !== "ENOENT" && code !== "ENOTEMPTY")
			failed.push(`${full}: ${code || message}`);
	}
}

/**
 * @param {string} full
 * @param {SweepState} sweep
 * @returns {void}
 */
function removeFile(full, { deleted, failed }) {
	try {
		fs.unlinkSync(full);
		deleted.push(full);
	} catch (e2) {
		const { code, message } = caught(e2);
		if (code !== "ENOENT") failed.push(`${full}: ${code || message}`);
	}
}

/**
 * @param {object} opts
 * @param {string} opts.dir
 * @param {number} [opts.now]
 * @param {() => {agents?: {startedAt?: unknown}[], why?: string}} opts.readAgents
 * @param {(where: string, err: Error) => void} opts.logError
 * @param {(full: string) => number|null} [opts.timeOf]
 * @returns {{deleted: string[], failed: string[], readOracle: boolean,
 *   why?: string}}
 */
function sweepScratch({
	dir,
	now = Date.now(),
	readAgents,
	logError,
	timeOf = writtenAtMs,
}) {
	if (!hasAgedCandidate(dir, now, timeOf))
		return { deleted: [], failed: [], readOracle: false };

	let listed;
	try {
		listed = typeof readAgents === "function" ? readAgents() : undefined;
	} catch (e) {
		listed = { why: `the liveness oracle threw: ${caught(e).message || e}` };
	}
	if (!listed?.agents) {
		const why = listed?.why || "no liveness oracle was passed";
		logError?.("sweepScratch", new Error(why));
		return { deleted: [], failed: [], readOracle: true, why };
	}

	/** @type {string[]} */
	const deleted = [];
	/** @type {string[]} */
	const failed = [];
	sweepDir(
		dir,
		{ now, earliest: earliestStart(listed.agents), deleted, failed, timeOf },
		{ exemptNames: EXEMPT_TOP_LEVEL },
	);
	if (failed.length > 0)
		logError?.(
			"sweepScratch",
			new Error(`could not sweep ${failed.length}: ${failed.join("; ")}`),
		);
	return { deleted, failed, readOracle: true };
}

module.exports = {
	earliestStart,
	sweepScratch,
	writtenAtMs,
};

if (require.main === module) {
	ignoreFailure(() => {
		const core = require("./arbiter-core");
		const { listedAgents } = require("./agent-liveness");
		const { hostRoot } = require("./host-root.js");
		sweepScratch({
			dir:
				process.env.WFC_SCRATCH_DIR || path.join(hostRoot(), ".claude", "tmp"),
			readAgents: () => listedAgents({ requireSelf: false }),
			logError: core.logError,
		});
	});
	process.exit(0);
}
