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

/** @param {import("./refill-decide.js").ResumeTarget} target */
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
