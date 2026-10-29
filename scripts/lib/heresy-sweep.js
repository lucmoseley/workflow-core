/*
 * heresy-sweep.js — when the monthly heresy sweep falls due (#3464, spec
 * #3365), as a pure core over the tracker's due issues.
 */

const SWEEP_TITLE = "Heresy sweep due";
/* #3365's "once a month", read as 30 days. Untraced. */
const SWEEP_DAYS = 30;
const SWEEP_MS = SWEEP_DAYS * 24 * 3_600_000;

/**
 * @typedef {{ number: number, closedAt: string | null, createdAt: string }} DueIssue
 * @typedef {{ due: boolean, last: string, next: string | null, why: string }} Verdict
 */

/** @param {string} iso */
const day = (iso) => iso.slice(0, 10);

/**
 * Due SWEEP_DAYS after the newest closed due issue's close, else after the
 * open one's creation, else at once.
 *
 * @param {{ closed: DueIssue | null, open: DueIssue | null }} issues
 * @param {number} nowMs
 * @returns {Verdict}
 */
function judgeSweep({ closed, open }, nowMs) {
	/** @type {{ at: string, last: string } | null} */
	let from = null;
	if (closed?.closedAt)
		from = {
			at: closed.closedAt,
			last: `#${closed.number}, closed ${day(closed.closedAt)}`,
		};
	else if (open)
		from = {
			at: open.createdAt,
			last: `none closed; #${open.number} open since ${day(open.createdAt)}`,
		};
	if (!from)
		return {
			due: true,
			last: "none",
			next: null,
			why: `no *${SWEEP_TITLE}* issue was ever filed`,
		};
	const nextMs = Date.parse(from.at) + SWEEP_MS;
	const due = nowMs >= nextMs;
	return {
		due,
		last: from.last,
		next: day(new Date(nextMs).toISOString()),
		why: `${due ? `${SWEEP_DAYS} days have passed` : `under ${SWEEP_DAYS} days`} since ${day(from.at)}`,
	};
}

module.exports = { SWEEP_TITLE, SWEEP_DAYS, judgeSweep };
