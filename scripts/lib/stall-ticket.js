/*
 * stall-ticket.js — the one ticket the refill loop keeps open while `main`
 * has not moved for lib/landing-stall.js's STALL_MS with a queue ref waiting
 * (workflow-core#2692, ruled at workflow-core#2672), filed as lib/queue-issue.js files it, and closed
 * with the stall's length once `main` moves, so a later stall files a new one
 * (workflow-core#4443).
 *
 * Its body changes only with the oldest waiting ref, the batch, or `main`'s
 * last move.
 *
 * A record in the markers directory names the stall a ticket was filed for,
 * so a pass with no stall on record reads no tracker. Residual: a ticket
 * filed from another checkout of the same repo is closed only by that one.
 */

const path = require("node:path");
const { STALL_MS } = require("./landing-stall.js");
const { formatHoursMin } = require("./queue-gauge.js");
const { STALL_TITLE: TITLE } = require("./queue-tickets.js");
const { recordTicket } = require("./record-ticket.js");

/**
 * @typedef {object} Stall
 * @property {string} waiting the oldest waiting queue ref and its sha
 * @property {string} movedAt when `main` last moved, ISO
 * @property {string|null} batch the batch the queue lander has under test
 */

/** @param {Stall} s */
function buildStallBody({ waiting, movedAt, batch }) {
	return `## What to build

\`main\` has not moved since ${movedAt}, over ${STALL_MS / 60_000} min, with \`${waiting}\` waiting (workflow-core#2692).

- Batch under test: ${batch === null ? "(none named in the heartbeat)" : `\`${batch}\``}

The lander's log: \`.lander.log\` in the checkout's markers directory.

## Acceptance criteria

- [ ] The cause is fixed, and the lander moves \`main\` again.
`;
}

const RECORD = ".landing-stall-ticket.json";

/**
 * @typedef {{main: string, movedAt: string}} StallRecord `main`'s sha and
 *   last move when the ticket was filed
 */

/** @param {unknown} rec @returns {StallRecord|null} */
function parseStallRecord(rec) {
	const { main, movedAt } = /** @type {{main?: unknown, movedAt?: unknown}} */ (
		rec ?? {}
	);
	const at = String(movedAt);
	return typeof main === "string" && Number.isFinite(Date.parse(at))
		? { main, movedAt: at }
		: null;
}

/**
 * @param {string} main the sha `main` moved to
 * @param {number|null} movedAt when, where known later than the stall began
 * @param {number} since
 */
function buildCloseComment(main, movedAt, since) {
	const from = new Date(since).toISOString();
	return movedAt !== null && movedAt > since
		? `\`main\` moved to \`${main}\` at ${new Date(movedAt).toISOString()}, after standing ${formatHoursMin(movedAt - since)} since ${from}.`
		: `\`main\` moved to \`${main}\`, having stood since ${from}.`;
}

/**
 * One supervision pass's act on the stall ticket: close the recorded stall's
 * ticket where `main` is no longer the sha it stood at, then file or refresh
 * one for `stall`. A close that throws keeps the record, so the next pass
 * retries it.
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers the markers directory
 * @returns {(pass: {main: string|null, movedAt: number|null,
 *   stall: Stall|null}) => string[]} the lines naming what it did
 */
function stallTicketTender(deps, markers) {
	const ticket = recordTicket(deps, {
		record: path.join(markers, RECORD),
		parse: parseStallRecord,
		noun: "stall ticket",
		subject: "the stalled queue",
		/* Fail-open (workflow-core#4443): the ticket stays open, and the next stall's
		 * filing refreshes it and writes a fresh record. */
		tornNote: "; an open stall ticket stays open until the next stall",
	});
	return ({ main, movedAt, stall }) => {
		/** @type {string[]} */
		const said = [];
		const rec = ticket.read(said);
		if (rec !== null && rec !== "torn" && main !== null && main !== rec.main) {
			const since = Date.parse(rec.movedAt);
			ticket.close(
				TITLE,
				() => buildCloseComment(main, movedAt, since),
				null,
				said,
			);
		}
		if (stall !== null && main !== null)
			ticket.file(
				TITLE,
				buildStallBody(stall),
				{ main, movedAt: stall.movedAt },
				said,
			);
		return said;
	};
}

module.exports = { stallTicketTender };
