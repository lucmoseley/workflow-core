/*
 * stall-ticket.js — the one ticket the refill loop keeps open while `main`
 * has not moved for lib/landing-stall.js's STALL_MS with `landing` ahead (#2692,
 * ruled at #2672), filed as lib/queue-issue.js files it, and closed with the
 * stall's length once `main` moves, so a later stall files a new one (#4443).
 *
 * Its body changes only with the batch, its red files or jobs, or `main`'s
 * last move.
 *
 * A record in the markers directory names the stall a ticket was filed for,
 * so a pass with no stall on record reads no tracker. Residual: a ticket
 * filed from another checkout of the same repo is closed only by that one.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { STALL_MS, formatHoursMin } = require("./landing-stall.js");
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

const RECORD = ".landing-stall-ticket.json";

/**
 * @typedef {{main: string, since: number}} StallRecord `main`'s sha and last
 *   move when the ticket was filed
 */

/**
 * The stall on record; null where none is, "torn" where the file will not
 * parse. A read failing for any reason but absence throws.
 * @param {string} file
 * @returns {StallRecord|null|"torn"}
 */
function readStallRecord(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (/** @type {{code?: unknown}} */ (e).code === "ENOENT") return null;
		throw e;
	}
	try {
		const rec = JSON.parse(text);
		const since = Date.parse(rec.movedAt);
		return typeof rec.main === "string" && Number.isFinite(since)
			? { main: rec.main, since }
			: "torn";
	} catch {
		return "torn";
	}
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
	const file = stallTicketFiler(deps);
	const close = queueIssueCloser(deps);
	const recordFile = path.join(markers, RECORD);
	return ({ main, movedAt, stall }) => {
		/** @type {string[]} */
		const lines = [];
		const rec = readStallRecord(recordFile);
		if (rec === "torn") {
			/* Fail-open (#4443): the ticket stays open, and the next stall's
			 * filing refreshes it and writes a fresh record. */
			fs.rmSync(recordFile, { force: true });
			lines.push(
				`stall ticket: ${recordFile} would not parse and is dropped; an open stall ticket stays open until the next stall.`,
			);
		} else if (rec !== null && main !== null && main !== rec.main) {
			const closed = close(TITLE, () =>
				buildCloseComment(main, movedAt, rec.since),
			);
			fs.rmSync(recordFile, { force: true });
			if (closed !== null) lines.push(`stall ticket: closed #${closed}.`);
		}
		if (stall !== null && main !== null) {
			lines.push(file(stall));
			writeFileAtomic(
				recordFile,
				`${JSON.stringify({ main, movedAt: stall.movedAt })}\n`,
				{ mkdir: true },
			);
		}
		return lines;
	};
}

module.exports = { STALL_TITLE: TITLE, stallTicketTender };
