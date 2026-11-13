/*
 * heresy-sweep.js — when the monthly heresy sweep falls due (workflow-core#3464, spec
 * workflow-core#3365) and what a finished one filed (workflow-core#4039), as a pure core over the
 * tracker's due issues.
 *
 * A CORE (base §T7): its one read is the port below.
 *
 *   find(state)   the newest due issue in that state, `closed` or `open`, or
 *                 null where there is none
 */

const { requiredGroup } = require("./regex-group.js");

const SWEEP_TITLE = "Heresy sweep due";
/* workflow-core#3365's "once a month", read as 30 days. Untraced. */
const SWEEP_DAYS = 30;
const SWEEP_MS = SWEEP_DAYS * 24 * 3_600_000;
/* Self-reported: nothing reconciles the figure with what the sweep filed, and a
 * later comment quoting the line takes over (workflow-core#4039). */
const FILED_LINE = /^\*\*Filed:\*\* (\d+) heres(?:y|ies)\b/m;

/**
 * @typedef {{ number: number, closedAt: string | null, createdAt: string }} DueIssue
 * @typedef {{ due: boolean, last: string, next: string | null, why: string }} Verdict
 */

/** @param {string} iso */
const day = (iso) => iso.slice(0, 10);

/**
 * Due SWEEP_DAYS after the newest closed due issue's close, else after the
 * open one's creation, else at once. The open issue is asked for only where
 * none has closed.
 *
 * @param {(state: "closed" | "open") => DueIssue | null} find
 * @param {number} nowMs
 * @returns {Verdict}
 */
function judgeSweep(find, nowMs) {
	const closed = find("closed");
	const open = closed ? null : find("open");
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

/**
 * The figure on the newest comment carrying a `**Filed:**` line, the skill's
 * close comment; the reason where none does.
 *
 * @param {number} issue the due issue's number
 * @param {{ body: string }[]} comments oldest first, as `gh issue view` lists them
 * @returns {import("./primitives-table.js").Count}
 */
function parseFiledHeresies(issue, comments) {
	for (const { body } of comments.toReversed()) {
		const filed = FILED_LINE.exec(body);
		if (filed) return { count: Number(requiredGroup(filed, 1, FILED_LINE)) };
	}
	return { unknown: `#${issue} has no **Filed:** comment` };
}

module.exports = { SWEEP_TITLE, SWEEP_DAYS, judgeSweep, parseFiledHeresies };
