const path = require("node:path");
const { formatHoursMin } = require("./queue-gauge.js");
const { STALL_MS, STALL_TITLE: TITLE } = require("./queue-tickets.js");
const { recordTicket } = require("./record-ticket.js");

/**
 * @typedef {object} Stall
 * @property {string} waiting
 * @property {string} movedAt
 * @property {string|null} batch
 */

const CRITERION = "The cause is fixed, and the lander moves `main` again.";

/** @param {Stall} s */
function buildStallBody({ waiting, movedAt, batch }) {
	return `## What to build

\`main\` has not moved since ${movedAt}, over ${STALL_MS / 60_000} min, with \`${waiting}\` waiting (workflow-core#2692).

- Batch under test: ${batch === null ? "(none named in the heartbeat)" : `\`${batch}\``}

The lander's log: \`.lander.log\` in the checkout's markers directory.

## Acceptance criteria

- [ ] ${CRITERION}
`;
}

const RECORD = ".landing-stall-ticket.json";

/** @typedef {{main: string, movedAt: string}} StallRecord */

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
 * @param {string} main
 * @param {number|null} movedAt
 * @param {number} since
 */
function buildCloseComment(main, movedAt, since) {
	const from = new Date(since).toISOString();
	return movedAt !== null && movedAt > since
		? `\`main\` moved to \`${main}\` at ${new Date(movedAt).toISOString()}, after standing ${formatHoursMin(movedAt - since)} since ${from}.`
		: `\`main\` moved to \`${main}\`, having stood since ${from}.`;
}

/**
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers
 * @returns {(pass: {main: string|null, movedAt: number|null,
 *   stall: Stall|null}) => string[]}
 */
function stallTicketTender(deps, markers) {
	const ticket = recordTicket(deps, {
		record: path.join(markers, RECORD),
		parse: parseStallRecord,
		noun: "stall ticket",
		subject: "the stalled queue",
		criterion: CRITERION,
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
