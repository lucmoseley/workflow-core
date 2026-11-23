const fs = require("node:fs");
const path = require("node:path");
const jevLog = require("./jev-log.js");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");

// #285
const TRIAL_START = "2026-09-20T13:00:00.000Z";

const TRIAL_START_MS = Date.parse(TRIAL_START);

// #255
const OUTAGE_START = "2026-09-20T04:25:00.000Z";

const OUTAGE_START_MS = Date.parse(OUTAGE_START);

/** @type {{from: string, to: string, why: string}[]} */
const OUTAGE_VOIDS = [
	{
		from: "2026-09-27T04:00:00.000Z",
		to: "2026-09-28T10:07:00.000Z",
		why: "the billing wall: a missing payment, not a vendor outage (#670)",
	},
	{
		from: "2026-10-28T10:03:39.600Z",
		to: "2026-11-03T12:39:56.000Z",
		why: "a key the gateway refused, not a vendor outage (#4144)",
	},
];

const OUTAGE_VOID_SPANS = OUTAGE_VOIDS.map((v) => ({
	from: Date.parse(v.from),
	to: Date.parse(v.to),
}));

/**
 * @param {number|null} ms
 * @returns {boolean}
 */
function inOutageVoid(ms) {
	return (
		ms !== null &&
		OUTAGE_VOID_SPANS.some(({ from, to }) => ms >= from && ms < to)
	);
}

/**
 * @template {{at?: unknown}} T
 * @param {T[]} lines
 * @returns {T[]}
 */
function outsideOutageVoid(lines) {
	return lines.filter((line) => !inOutageVoid(jevLog.whenOf(line)));
}

// guess, #175
const WRONG_IN = 10;

// guess, #175
const LIMB1_SESSIONS = 20;

// guess, #175
const OUTAGE_IN = 10;

const VERDICTS_NAME = ".jev-verdicts.jsonl";

const VERDICTS = ["right", "wrong"];

/**
 * @param {string} root
 * @returns {string}
 */
function verdictsPath(root) {
	return path.join(markersDir(root), VERDICTS_NAME);
}

/**
 * @param {number|null} ms
 * @returns {boolean}
 */
function inTrial(ms) {
	return ms !== null && ms > TRIAL_START_MS;
}

/** @typedef {{at: string, messageHash: string, verdict: string, note?: string}} VerdictLine */

/**
 * @param {string} root
 * @returns {Map<string, VerdictLine>}
 */
function readVerdicts(root) {
	/** @type {Map<string, VerdictLine>} */
	const byHash = new Map();
	for (const line of readJsonl(verdictsPath(root))?.rows ?? []) {
		if (typeof line.messageHash !== "string") continue;
		if (!VERDICTS.includes(String(line.verdict))) continue;
		byHash.set(line.messageHash, /** @type {VerdictLine} */ (line));
	}
	return byHash;
}

/**
 * @param {{root: string, messageHash: string, verdict: string, note?: string}} spec
 * @returns {VerdictLine}
 */
function recordVerdict({ root, messageHash, verdict, note }) {
	if (!VERDICTS.includes(verdict))
		throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
	/** @type {VerdictLine} */
	const line = {
		at: new Date().toISOString(),
		messageHash,
		verdict,
		...(note ? { note } : {}),
	};
	const file = verdictsPath(root);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	return line;
}

/**
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {[string, number][]}
 */
function sessionStarts(lines) {
	/** @type {Map<string, number>} */
	const startedAt = new Map();
	for (const line of lines) {
		const ms = jevLog.whenOf(line);
		if (ms === null || typeof line.session !== "string") continue;
		const seen = startedAt.get(line.session);
		if (seen === undefined || ms < seen) startedAt.set(line.session, ms);
	}
	return [...startedAt.entries()].sort((a, b) => a[1] - b[1]);
}

/**
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {[string, number][]}
 */
function trialSessionStarts(lines) {
	return sessionStarts(lines).filter(([, ms]) => inTrial(ms));
}

/**
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {string[]}
 */
function sessionsInTrial(lines) {
	return trialSessionStarts(lines).map(([session]) => session);
}

/**
 * @param {{at?: unknown, session?: unknown, outcome?: unknown}[]} lines
 * @returns {string[]}
 */
function limb2WindowSessions(lines) {
	const counted = outsideOutageVoid(lines).filter(
		(line) => line.outcome !== "refused",
	);
	return sessionStarts(counted)
		.filter(([, ms]) => ms > OUTAGE_START_MS)
		.map(([session]) => session);
}

/**
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {string[]}
 */
function limb1WindowSessions(lines) {
	return trialSessionStarts(lines)
		.slice(0, LIMB1_SESSIONS)
		.map(([session]) => session);
}

/**
 * @typedef {{start: string, outageStart: string,
 *   outageVoids: {from: string, to: string, why: string}[], sessions: number,
 *   limb1Sessions: number, limb1Closed: boolean, flagged: number,
 *   right: number, wrong: number, unjudged: number, limb2Sessions: number,
 *   outageSessions: number, limb1: string, limb2: string}} Standing
 */

/**
 * @param {{lines: TrialLine[], verdicts: Map<string, VerdictLine>}} spec
 * @returns {Standing}
 */
function stand({ lines, verdicts }) {
	const trialSessions = sessionsInTrial(lines);
	const limb1Window = new Set(limb1WindowSessions(lines));
	const limb2Window = new Set(limb2WindowSessions(lines));

	const { flagged, right, wrong, unjudged } = judgedFlags(
		lines,
		limb1Window,
		verdicts,
	);
	const outages = outageSessionsIn(lines, limb2Window).size;
	const sessions = trialSessions.length;

	let limb1 = "holding";
	if (wrong * WRONG_IN > flagged) limb1 = "tripped";
	else if ((wrong + unjudged) * WRONG_IN > flagged) limb1 = "pending";
	const limb2 = outages * OUTAGE_IN > limb2Window.size ? "tripped" : "holding";

	return {
		start: TRIAL_START,
		outageStart: OUTAGE_START,
		outageVoids: OUTAGE_VOIDS,
		sessions,
		limb1Sessions: limb1Window.size,
		limb1Closed: sessions >= LIMB1_SESSIONS,
		flagged,
		right,
		wrong,
		unjudged,
		limb2Sessions: limb2Window.size,
		outageSessions: outages,
		limb1,
		limb2,
	};
}

/**
 * @typedef {{at?: unknown, session?: unknown, outcome?: unknown,
 *   messageHash?: unknown}} TrialLine
 */

/**
 * @param {TrialLine[]} lines
 * @param {Set<string>} limb1Window
 * @param {Map<string, VerdictLine>} verdicts
 * @returns {{flagged: number, right: number, wrong: number, unjudged: number}}
 */
function judgedFlags(lines, limb1Window, verdicts) {
	let flagged = 0;
	let right = 0;
	let wrong = 0;
	let unjudged = 0;
	for (const line of lines) {
		if (typeof line.session !== "string") continue;
		if (line.outcome !== "flagged" || !limb1Window.has(line.session)) continue;
		flagged++;
		const hash = typeof line.messageHash === "string" ? line.messageHash : "";
		const verdict = verdicts.get(hash)?.verdict;
		if (verdict === "wrong") wrong++;
		else if (verdict === "right") right++;
		else unjudged++;
	}
	return { flagged, right, wrong, unjudged };
}

/**
 * @param {TrialLine[]} lines
 * @param {Set<string>} limb2Window
 * @returns {Set<string>}
 */
function outageSessionsIn(lines, limb2Window) {
	/** @type {Set<string>} */
	const outageSessions = new Set();
	for (const line of lines) {
		if (typeof line.session !== "string") continue;
		if (
			line.outcome === "outage" &&
			limb2Window.has(line.session) &&
			!inOutageVoid(jevLog.whenOf(line))
		)
			outageSessions.add(line.session);
	}
	return outageSessions;
}

module.exports = {
	inTrial,
	sessionsInTrial,
	limb2WindowSessions,
	limb1WindowSessions,
	inOutageVoid,
	WRONG_IN,
	OUTAGE_IN,
	VERDICTS,
	readVerdicts,
	recordVerdict,
	stand,
};
