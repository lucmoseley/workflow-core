/*
 * refill-carry.js — the refill loop's one choice between resuming a stopped
 * session on its own seat and carrying it to another first (workflow-core#5302): its
 * resume, its adoption after a kill, and the record and log line of where it
 * went. `to` unset or the session's own seat resumes in place.
 */

const { buildMovedReason, seatIdOf } = require("./refill-seats.js");

/**
 * @typedef {import("./refill-blocks.js").Resumed} Resumed
 * @typedef {import("./refill-blocks.js").Adopted} Adopted
 * @typedef {import("./refill-limits.js").MoveTarget} MoveTarget
 * @typedef {{sessionId: string, cwd: string}} SessionIds
 * @typedef {{seat: string, keyVar?: string}} Seated
 */

/**
 * @param {string} from
 * @param {string} [to]
 * @returns {to is string}
 */
const isCarried = (from, to) => to !== undefined && to !== from;

/**
 * A parked route's carry: the seat `from` its session stopped on, the seat
 * `to` it resumes on, and its ids.
 * @param {import("./refill-decide.js").ResumeTarget} target
 */
const parkedCarryOf = ({ seat, from, sessionId, cwd }) => ({
	from: from ?? seat,
	to: seat,
	ids: { sessionId, cwd },
});

/**
 * @template {Seated} L
 * @param {{resumeStopped: (l: L, prompt: string, ids: SessionIds) => Resumed,
 *   moveSession: (l: L, target: MoveTarget, prompt: string,
 *     ids: SessionIds) => Resumed}} io
 * @param {L} l
 * @param {string|undefined} to
 * @param {{prompt: string, ids: SessionIds, inPlace?: () => Resumed}} how
 * @returns {Resumed}
 */
const resumeOnSeat = (io, l, to, { prompt, ids, inPlace }) =>
	isCarried(l.seat, to)
		? io.moveSession(l, { seat: to }, prompt, ids)
		: (inPlace ?? (() => io.resumeStopped(l, prompt, ids)))();

/**
 * @template {Seated} L
 * @param {(l: L, ids: SessionIds, since: number, move?: MoveTarget) =>
 *   Adopted} adoptResumed
 * @param {L} l
 * @param {string|undefined} to
 * @param {{ids: SessionIds, since: number}} how
 * @returns {Adopted}
 */
function adoptOnSeat(adoptResumed, l, to, { ids, since }) {
	if (!isCarried(l.seat, to)) return adoptResumed(l, ids, since);
	const move = { seat: to };
	return adoptResumed({ ...l, ...seatIdOf(move) }, ids, since, move);
}

/**
 * The fields a launch record of a session stopped on `from` and resumed on
 * `to` takes: the seat it went to and why, none where it stayed.
 * @param {string} from
 * @param {string} [to]
 * @returns {{seat?: string,
 *   reason?: import("./refill-decide.js").SeatReason}}
 */
const carriedOnto = (from, to) =>
	isCarried(from, to)
		? { ...seatIdOf({ seat: to }), reason: buildMovedReason(from) }
		: {};

/**
 * The resume log line's note of a carry from `from` to `to`, empty where none.
 * @param {string} from
 * @param {string} [to]
 */
const buildCarriedText = (from, to) =>
	isCarried(from, to) ? `, moved from ${from} to ${to}` : "";

module.exports = {
	adoptOnSeat,
	buildCarriedText,
	carriedOnto,
	parkedCarryOf,
	resumeOnSeat,
};
