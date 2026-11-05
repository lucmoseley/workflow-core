/*
 * stall-ticket.js — the one ticket the refill loop keeps open while `main`
 * has not moved for lib/landing-stall.js's STALL_MS with `landing` ahead (#2692,
 * ruled at #2672), filed as lib/queue-issue.js files it, and closed with the
 * stall's length once `main` moves, so a later stall files a new one and each
 * stall counts once (#4443).
 *
 * Its body changes only with the batch, its red files or jobs, or `main`'s
 * last move.
 *
 * A record in the markers directory names the stall a ticket was filed for,
 * so a pass with no stall on record reads no tracker. Residual: a ticket
 * filed from another checkout of the same repo is closed only by that one.
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { STALL_MS } = require("./landing-stall.js");
const { failingList } = require("./lander.js");
const { queueIssueCloser, queueIssueFiler } = require("./queue-issue.js");

const TITLE = "Landing queue stalled: main has not moved for 2 h";

/**
 * @typedef {object} Stall
 * @property {string} landing `landing`'s tip
 * @property {string} movedAt when `main` last moved, ISO
 * @property {string|null} batch the batch the lander has under test
 * @property {import("./lander.js").Failing|null} red the
 *   red batch's failing files and CI jobs, null where no batch is red
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

/**
 * @param {number} ms
 * @returns {string}
 */
function formatStood(ms) {
	const min = Math.round(ms / 60_000);
	return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * When the stall on record began, in ms; null where none is recorded or the
 * record will not parse.
 * @param {string} file
 * @returns {number|null}
 */
function readStallRecord(file) {
	try {
		const at = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).movedAt);
		return Number.isFinite(at) ? at : null;
	} catch {
		return null;
	}
}

/**
 * One supervision pass's act on the stall ticket: close the recorded stall's
 * ticket where `main` has moved since, then file or refresh one for `stall`.
 * A close that throws keeps the record, so the next pass retries it.
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} recordFile
 * @returns {(pass: {movedAt: number|null, stall: Stall|null}) => string[]}
 *   the lines naming what it did
 */
function stallTicketTender(deps, recordFile) {
	const file = stallTicketFiler(deps);
	const close = queueIssueCloser(deps);
	return ({ movedAt, stall }) => {
		/** @type {string[]} */
		const lines = [];
		const since = readStallRecord(recordFile);
		if (since !== null && movedAt !== null && movedAt > since) {
			const moved = new Date(movedAt).toISOString();
			const closed = close(
				TITLE,
				() =>
					`\`main\` moved at ${moved}, after standing ${formatStood(movedAt - since)} since ${new Date(since).toISOString()}.`,
			);
			fs.rmSync(recordFile, { force: true });
			if (closed !== null) lines.push(`stall ticket: closed #${closed}.`);
		}
		if (stall !== null) {
			lines.push(file(stall));
			writeFileAtomic(
				recordFile,
				`${JSON.stringify({ movedAt: stall.movedAt })}\n`,
				{ mkdir: true },
			);
		}
		return lines;
	};
}

module.exports = { STALL_TITLE: TITLE, stallTicketTender };
