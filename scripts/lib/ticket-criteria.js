/*
 * ticket-criteria.js — an issue body's acceptance criteria as task-list items,
 * read by check-ticket-criteria.js after a close and by both close routes
 * before one, so the three cannot disagree on what is unmet (workflow-core#1640); and
 * ticked by the landing-queue closers as they close (workflow-core#5354).
 */

const { requiredGroup } = require("./regex-group.js");

// `## Acceptance criteria` or a bare `## Acceptance` (workflow-core#2481). Residual: a
// trailing colon, `## Acceptance tests` or a bold pseudo-heading reads as none.
const CRITERIA_HEADING = /^\s{0,3}(#{1,6})\s+acceptance(?:\s+criteria)?\s*$/i;
const HEADING = /^\s{0,3}(#{1,6})\s+/;

/*
 * The acceptance-criteria section: from its heading to the next heading of the
 * same or higher level.
 *
 * Never widen this to a whole-body scan. Ticket bodies quote ledger items
 * containing bracketed text, and a "Blocked by" list parses as a task list —
 * both would report as unmet criteria.
 */
/**
 * The criteria section's line range, [from, to).
 * @param {readonly string[]} lines
 * @returns {[number, number]|null}
 */
function criteriaRange(lines) {
	for (const [start, line] of lines.entries()) {
		const heading = CRITERIA_HEADING.exec(line);
		if (!heading) continue;
		const level = requiredGroup(heading, 1, CRITERIA_HEADING).length;
		const end = lines.findIndex((l, i) => {
			const m = i > start ? HEADING.exec(l) : null;
			return m !== null && requiredGroup(m, 1, HEADING).length <= level;
		});
		return [start + 1, end === -1 ? lines.length : end];
	}
	return null;
}

/** @param {string | null | undefined} body */
function criteriaSection(body) {
	if (!body) return null;
	const lines = body.split(/\r?\n/);
	const range = criteriaRange(lines);
	return range === null ? null : lines.slice(...range).join("\n");
}

/*
 * `**waived:** <why>` on an unticked criterion: checked, found not met, left
 * unticked on purpose. Reports without failing — the alternative is clearing a
 * red run by ticking something untrue. The reason is required; a bare marker
 * still fails.
 */
const WAIVER = /\*\*waived:?\*\*\s*(\S.*|)$/i;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s*(\S.*|)$/;

/**
 * GFM task-list items in a chunk of markdown, as {ticked, waived, text}.
 * @param {string} md
 */
function taskItems(md) {
	const items = [];
	for (const line of md.split(/\r?\n/)) {
		const m = line.match(TASK_ITEM);
		if (!m) continue;
		const text = requiredGroup(m, 2, TASK_ITEM).trim();
		const w = text.match(WAIVER);
		items.push({
			ticked: requiredGroup(m, 1, TASK_ITEM).toLowerCase() === "x",
			waived: Boolean(w?.[1]?.trim()),
			text,
		});
	}
	return items;
}

/**
 * A criterion a completed close still owes: unticked and unwaived.
 * @param {{ticked: boolean, waived: boolean}} item
 */
const isUnmet = (item) => !item.ticked && !item.waived;

/**
 * The body's unmet criteria. Empty where it has no criteria section, whatever
 * the issue's labels (workflow-core#1640).
 * @param {string | null | undefined} body
 */
function unmetCriteria(body) {
	const section = criteriaSection(body);
	return section === null ? [] : taskItems(section).filter(isUnmet);
}

/**
 * The body with the unmet criterion reading `criterion` ticked, each line
 * keeping its own ending.
 * @param {string} body
 * @param {string} criterion the item's text, as taskItems reads it
 * @returns {string}
 */
function tickCriteria(body, criterion) {
	const lines = body.split("\n");
	const bare = lines.map((l) => l.replace(/\r$/, ""));
	const range = criteriaRange(bare);
	if (range === null) return body;
	const [from, to] = range;
	return lines
		.map((line, i) => {
			const [item] =
				i >= from && i < to && TASK_ITEM.test(bare[i] ?? "")
					? taskItems(bare[i] ?? "")
					: [];
			return item && isUnmet(item) && item.text === criterion
				? line.replace("[ ]", "[x]")
				: line;
		})
		.join("\n");
}

/**
 * Ticks the open issue's `criterion` through `refresh`, the route its filer
 * writes the body by, for a closer whose close comment states it met
 * (workflow-core#5354). Run before the close: a close that then throws leaves the issue
 * open and ticked until the next pass retries it.
 * @param {number} n
 * @param {string} body its body as read
 * @param {string} criterion the filer's own criterion
 * @param {(n: number, body: string) => unknown} refresh
 */
function tickBeforeClose(n, body, criterion, refresh) {
	const ticked = tickCriteria(body, criterion);
	if (ticked !== body) refresh(n, ticked);
}

module.exports = {
	criteriaSection,
	isUnmet,
	taskItems,
	tickBeforeClose,
	tickCriteria,
	unmetCriteria,
};
