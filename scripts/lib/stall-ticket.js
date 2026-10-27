/*
 * stall-ticket.js — the one ticket the refill loop keeps open while `main`
 * has not moved for lib/landing-stall.js's STALL_MS with `landing` ahead (#2692,
 * ruled at #2672), filed as lib/queue-issue.js files it.
 *
 * Its body changes only with the batch, its red files or `main`'s last move.
 */

const { STALL_MS } = require("./landing-stall.js");
const { failingList, queueIssueFiler } = require("./queue-issue.js");

const TITLE = "Landing queue stalled: main has not moved for 2 h";

/**
 * @typedef {object} Stall
 * @property {string} landing `landing`'s tip
 * @property {string} movedAt when `main` last moved, ISO
 * @property {string|null} batch the batch the lander has under test
 * @property {string[]|null} red the red batch's failing files, null where no
 *   batch is red
 */

/** @param {Stall} s */
function buildStallBody({ landing, movedAt, batch, red }) {
	return `## What to build

\`main\` has not moved since ${movedAt}, over ${STALL_MS / 60_000} min, with \`landing\` ahead of it at \`${landing}\` (#2692).

- Batch under test: ${batch === null ? "(none named in the heartbeat)" : `\`${batch}\``}

${red === null ? "No batch is red: the lander is testing, or stuck inside a call." : `Red:\n${failingList(red)}`}

The lander's log: \`.lander.log\` in the checkout's markers directory.

## Acceptance criteria

- [ ] The cause is fixed, and the lander moves \`main\` again.
`;
}

/**
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @returns {(s: Stall) => string}
 */
function stallTicketFiler(deps) {
	const file = queueIssueFiler(deps);
	return (s) =>
		file(
			{
				title: TITLE,
				standalone:
					"The stall ticket tracks the landing queue, not one ticket's work.",
				noun: "stall ticket",
				subject: "the stalled queue",
			},
			buildStallBody(s),
		);
}

module.exports = { STALL_TITLE: TITLE, stallTicketFiler };
