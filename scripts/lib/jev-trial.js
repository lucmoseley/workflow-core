/*
 * jev-trial.js — the Jev advisory trial's start line, its verdict store, and
 * the arithmetic that says where workflow-core#175's stop condition stands (workflow-core#253).
 *
 * WHY A SECOND FILE BESIDE `jev-log.js`. That one names where the guard's own
 * log lives and nothing else. This one holds the three things the log cannot
 * carry: when the trial began, what the founder judged each flag, and how the
 * two limbs are counted. The guard writes none of it — it appends and moves
 * on — so keeping it here is what lets `check-jev-flags.js` and
 * `jev-verdict.js` agree without either importing the guard.
 *
 * THE START LINE IS A COMMITTED CONSTANT, not a marker file. Everything under
 * `.claude/tmp/markers/` is gitignored and swept; a boundary living there
 * would vanish on the first clean checkout and the trial would silently
 * restart. `TRIAL_START` is below, in source, where a change to it shows up in
 * a diff.
 *
 * WHAT THE START LINE EXCLUDES, and why it is not a thumb on the scale. Every
 * flag and every outage logged before it was raised while the guard was still
 * being built, and every one of those outages was traced at workflow-core#253 to a defect
 * since fixed. Counting build-window defects as trial evidence would reverse
 * the adoption on the strength of bugs that no longer exist.
 *
 * WHY THE START LINE MOVED, ONCE (workflow-core#285). The first window closed over 20
 * sessions with every flag in it UNJUDGED, because the guard logged a digest
 * of each flagged message and never its text: judging one meant the founder
 * noticing a screen warn mid-turn and typing a command against a hash. Limb 1
 * counts WRONG flags, so a window of unjudgeable flags cannot trip it and
 * cannot clear it either — it measured nothing. THE THRESHOLD AND THE WIDTH
 * ARE UNTOUCHED: this
 * restarts the measurement, it does not soften it, and limb 2 keeps both its
 * own start line and every session of evidence it had (workflow-core#276 ruled the move).
 *
 * THE PRE-BOUNDARY FLAGS ARE EXCLUDED, NOT UNJUDGEABLE (workflow-core#253). None of them
 * could be judged in any case — every line logged before workflow-core#285 carries a digest
 * of the message and never its text, so a flag not judged in the session that
 * raised it has nothing left to judge — but that is not why they are out.
 *
 * A SESSION BELONGS TO THE TRIAL BY ITS FIRST LOGGED LINE. Limb 2 counts
 * sessions rather than turns, so a session straddling the boundary has to land
 * on one side of it; the first line is the side it started on. `inTrial` is
 * exported so nothing decides that question a second way.
 *
 * TWO READINGS OF workflow-core#175 THIS HAD TO PICK BETWEEN, neither of them a change to
 * the stop condition (workflow-core#253 puts that out of scope):
 *   - "more than one WRONG flag in ten flagged turns" is read as a RATE, so
 *     one wrong of one flagged trips it. The alternative — ten flagged turns
 *     before the limb may trip at all — lets a guard that flags rarely and
 *     wrongly survive on a thin denominator.
 *   - "over the first 20 sessions" is read as binding LIMB 1 ALONE, which is
 *     where workflow-core#175's own sentence puts it: the semicolon before the outage limb
 *     ends the clause. So limb 2 counts every session after its own start
 *     line, uncapped.
 *
 * LIMB 2 HAS A START LINE OF ITS OWN (`OUTAGE_START`), now the earlier of the
 * two. The four outages recorded before it were one fault, not four (workflow-core#255),
 * and the founder ruled on workflow-core#164 that they are struck and limb 2 counts from
 * the fix. Limb 1 is untouched by workflow-core#255: nothing was wrong with how flags were
 * raised.
 *
 * LIMB 2 ALSO VOIDS ONE STRETCH, rather than moving its line again (workflow-core#670): the
 * billing wall of 27-28 Sep (`OUTAGE_VOID_FROM`/`_TO`). Moving the line would
 * have thrown away a week of sessions measured under the right conditions.
 */

const fs = require("node:fs");
const path = require("node:path");
const jevLog = require("./jev-log.js");
const { markersDir } = require("./marker-root.js");

/**
 * The trial's start line, EXCLUSIVE: the hour boundary after workflow-core#285's
 * stored-message-text change landed, ROUNDED FORWARD from the commit instant
 * so that no turn the change had yet to cover is counted.
 */
const TRIAL_START = "2026-09-20T13:00:00.000Z";

const TRIAL_START_MS = Date.parse(TRIAL_START);

/**
 * Limb 2's own start line: the commit that landed workflow-core#255's bounded re-ask,
 * EXCLUSIVE. Sessions before it contribute neither an outage nor a
 * denominator to limb 2 — see the header for the ruling.
 */
const OUTAGE_START = "2026-09-20T04:25:00.000Z";

const OUTAGE_START_MS = Date.parse(OUTAGE_START);

/**
 * Limb 2's one voided stretch, [from, to): the AI Gateway billing wall, when
 * every call 403'd because Jev was never in the free tier and no credits had
 * been bought (workflow-core#661). Not a vendor fault, so not the limb's subject (workflow-core#670).
 * Limb 2 drops every line inside it before reading the log, so a session is
 * judged on its lines outside it alone, whichever side it started on; one
 * logged wholly inside it counts toward neither side.
 */
const OUTAGE_VOID_FROM = "2026-09-27T04:00:00.000Z";
const OUTAGE_VOID_TO = "2026-09-28T10:07:00.000Z";

const OUTAGE_VOID_FROM_MS = Date.parse(OUTAGE_VOID_FROM);
const OUTAGE_VOID_TO_MS = Date.parse(OUTAGE_VOID_TO);

/**
 * @param {number|null} ms
 * @returns {boolean}
 */
function inOutageVoid(ms) {
	return ms !== null && ms >= OUTAGE_VOID_FROM_MS && ms < OUTAGE_VOID_TO_MS;
}

/**
 * @template {{at?: unknown}} T
 * @param {T[]} lines
 * @returns {T[]}
 */
function outsideOutageVoid(lines) {
	return lines.filter((line) => !inOutageVoid(jevLog.whenOf(line)));
}

/** workflow-core#175's limb 1: more than one WRONG flag in ten flagged turns. */
const WRONG_IN = 10;

/** workflow-core#175's limb 1 is measured over the trial's first this-many sessions. */
const LIMB1_SESSIONS = 20;

/** workflow-core#175's limb 2: an outage notice in more than one session in ten. */
const OUTAGE_IN = 10;

const VERDICTS_NAME = ".jev-verdicts.jsonl";

/** The two a founder may record. `unjudged` is the absence of a line, never one. */
const VERDICTS = ["right", "wrong"];

/**
 * @param {string} root
 * @returns {string}
 */
function verdictsPath(root) {
	return path.join(markersDir(root), VERDICTS_NAME);
}

/**
 * Whether a moment falls inside the trial.
 * @param {number|null} ms
 * @returns {boolean}
 */
function inTrial(ms) {
	return ms !== null && ms > TRIAL_START_MS;
}

/**
 * One recorded verdict, as it sits on disk.
 * @typedef {{at: string, messageHash: string, verdict: string, note?: string}} VerdictLine
 */

/**
 * Every verdict on record, latest per hash. Appending is how a verdict is
 * CORRECTED — the founder reruns the command — so the last line for a hash is
 * the one that counts and the earlier ones stay as an audit trail.
 *
 * An absent file is an empty map: nothing has been judged here yet. A file
 * that exists and will not read throws, so a permissions fault is not read as
 * "nobody judged anything".
 *
 * @param {string} root
 * @returns {Map<string, VerdictLine>}
 */
function readVerdicts(root) {
	/** @type {Map<string, VerdictLine>} */
	const byHash = new Map();
	for (const line of jevLog.readJsonl(verdictsPath(root))?.lines ?? []) {
		if (typeof line.messageHash !== "string") continue;
		if (!VERDICTS.includes(String(line.verdict))) continue;
		byHash.set(line.messageHash, /** @type {VerdictLine} */ (line));
	}
	return byHash;
}

/**
 * Append one verdict. Creates the store on first use. Throws on a write fault
 * rather than failing open: unlike the guard, this is a command the founder
 * ran on purpose and a silently dropped verdict is worse than an error.
 *
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
 * Every session in `lines`, oldest first, each stamped by its FIRST logged
 * line. Unfiltered: the two limbs cut it at their own start lines, which are
 * different instants.
 *
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
 * The sessions belonging to the trial, oldest first, each judged by its FIRST
 * logged line. `sessionsInTrial` wraps it for `jev-verdict.js --list`, so a
 * turn is marked by the same rule the standing counts it by — a session
 * straddling the start line must not read one way in one place and the other
 * way in the other.
 *
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {[string, number][]}
 */
function trialSessionStarts(lines) {
	return sessionStarts(lines).filter(([, ms]) => inTrial(ms));
}

/**
 * The same sessions, ids only.
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {string[]}
 */
function sessionsInTrial(lines) {
	return trialSessionStarts(lines).map(([session]) => session);
}

/**
 * The sessions counted toward limb 2's denominator: those starting after
 * `OUTAGE_START`. Independent of `TRIAL_START` (workflow-core#285) — limb 2 has a start
 * line of its own (see header), so a session need not be in the trial at all
 * to be evidence for limb 2. Exported so `jev-verdict.js --list` marks a turn
 * by the same rule `stand()` counts it by, rather than re-deriving it.
 *
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {string[]}
 */
function limb2WindowSessions(lines) {
	return sessionStarts(outsideOutageVoid(lines))
		.filter(([, ms]) => ms > OUTAGE_START_MS)
		.map(([session]) => session);
}

/**
 * The trial sessions counted toward limb 1's window — the first
 * `LIMB1_SESSIONS` of them, oldest first. A trial session past this window
 * contributes nothing further to limb 1's tally (`limb1Closed`), so it is
 * neither "pre-trial" nor "counted" and callers must tell the two apart.
 *
 * @param {{at?: unknown, session?: unknown}[]} lines
 * @returns {string[]}
 */
function limb1WindowSessions(lines) {
	return trialSessionStarts(lines)
		.slice(0, LIMB1_SESSIONS)
		.map(([session]) => session);
}

/**
 * Where the trial stands, as `check-jev-flags.js` prints it. `limb1` is
 * `holding`, `pending` or `tripped`; `limb2` is `holding` or `tripped`, having
 * nothing to judge.
 *
 * @typedef {{start: string, outageStart: string,
 *   outageVoid: {from: string, to: string}, sessions: number,
 *   limb1Sessions: number, limb1Closed: boolean, flagged: number,
 *   right: number, wrong: number, unjudged: number, limb2Sessions: number,
 *   outageSessions: number, limb1: string, limb2: string}} Standing
 */

/**
 * Where the trial stands, both limbs, from the log lines and the verdict store.
 *
 * `lines` is every log line the caller could find — live and rotated both, in
 * any order. Lines before the start line, and lines carrying no readable
 * timestamp or session, are not trial evidence and are dropped here rather
 * than by each caller.
 *
 * LIMB 1 IS `pending` UNTIL EVERY FLAG IN THE WINDOW IS JUDGED, and `pending`
 * is reported rather than folded into `holding`: an unjudged flag is a flag
 * that MIGHT be wrong, so a clean-looking rate with judgements outstanding is
 * not evidence the adoption stands.
 *
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

	/* `> flagged / WRONG_IN` as a cross-multiplication, so a rate that lands
	 * exactly on the threshold is not tipped over it by a float. */
	let limb1 = "holding";
	if (wrong * WRONG_IN > flagged) limb1 = "tripped";
	else if ((wrong + unjudged) * WRONG_IN > flagged) limb1 = "pending";
	const limb2 = outages * OUTAGE_IN > limb2Window.size ? "tripped" : "holding";

	return {
		start: TRIAL_START,
		outageStart: OUTAGE_START,
		outageVoid: { from: OUTAGE_VOID_FROM, to: OUTAGE_VOID_TO },
		sessions,
		limb1Sessions: limb1Window.size,
		/* Limb 1's window is over: no later session can add a flag to it, so the
		 * verdict it reads is the one it keeps. Limb 2 has no such window. */
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
 * A trial log line. Parsed JSON, so every field is checked where it is read.
 * @typedef {{at?: unknown, session?: unknown, outcome?: unknown,
 *   messageHash?: unknown}} TrialLine
 */

/**
 * Limb 1's flags, by the verdict each carries.
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
 * The limb 2 sessions that logged an outage outside the void.
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
	TRIAL_START,
	OUTAGE_START,
	inOutageVoid,
	WRONG_IN,
	OUTAGE_IN,
	VERDICTS,
	readVerdicts,
	recordVerdict,
	stand,
};
