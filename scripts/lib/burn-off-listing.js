const { caught } = require("./caught.js");
const { isTerminalAgent, readSeatListing } = require("./agent-liveness.js");
const { readPlanDirs } = require("./plan-dirs.js");
const { readLastModel } = require("./session-transcript.js");
const { findTranscript } = require("./transcript.js");

// guess, workflow-core#5529
const LISTING_TIMEOUT_MS = 20_000;

/**
 * @typedef {{seat: string, sessionId: string, cwd: string, name: string,
 *   model: string}} LiveSession
 */

/**
 * @param {string} seat
 * @param {any} a
 * @param {(seat: string, sessionId: string) => string} modelOf
 * @returns {LiveSession | null}
 */
function liveSession(seat, a, modelOf) {
	if (a?.kind !== "background" || typeof a.sessionId !== "string") return null;
	if (isTerminalAgent(a)) return null;
	return {
		seat,
		sessionId: a.sessionId,
		cwd: typeof a.cwd === "string" ? a.cwd : "",
		name: typeof a.name === "string" ? a.name : "",
		model: modelOf(seat, a.sessionId),
	};
}

/** @type {(seat: string, sessionId: string) => string} */
function readTranscriptModel(seat, sessionId) {
	const file = findTranscript(seat, sessionId);
	return file ? readLastModel(file) : "";
}

/**
 * @param {string} home
 * @param {{read?: typeof readSeatListing, plans?: typeof readPlanDirs,
 *   modelOf?: (seat: string, sessionId: string) => string}} [ports]
 * @returns {{sessions: LiveSession[], faults: string[]}}
 */
function readLiveSessions(home, ports = {}) {
	const {
		read = readSeatListing,
		plans = readPlanDirs,
		modelOf = readTranscriptModel,
	} = ports;
	/** @type {LiveSession[]} */
	const sessions = [];
	/** @type {string[]} */
	const faults = [];
	for (const seat of plans(home)) {
		let got;
		try {
			got = read(seat, LISTING_TIMEOUT_MS);
		} catch (e) {
			faults.push(`${seat}: listing not read: ${caught(e).message}`);
			continue;
		}
		if ("why" in got) faults.push(`${seat}: ${got.why}`);
		else
			for (const a of got.agents) {
				const s = liveSession(seat, a, modelOf);
				if (s) sessions.push(s);
			}
	}
	return { sessions, faults };
}

module.exports = { readLiveSessions };
