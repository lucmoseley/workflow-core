/*
 * ticket-criteria.js — an issue body's acceptance criteria as task-list items,
 * read by check-ticket-criteria.js after a close and by both close routes
 * before one, so the three cannot disagree on what is unmet (#1640).
 *
 * Run as `unmet`, it prints {"unmet": [text, …]} for an issue body on stdin.
 */

const { requiredGroup } = require("./regex-group.js");
const { writeFd } = require("./write-fd.js");

// `## Acceptance criteria` or a bare `## Acceptance` (#2481). Residual: a
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
/** @param {string | null | undefined} body */
function criteriaSection(body) {
	if (!body) return null;
	const lines = body.split(/\r?\n/);
	for (const [start, line] of lines.entries()) {
		const heading = CRITERIA_HEADING.exec(line);
		if (!heading) continue;
		const level = requiredGroup(heading, 1, CRITERIA_HEADING).length;
		const rest = lines.slice(start + 1);
		const end = rest.findIndex((l) => {
			const m = HEADING.exec(l);
			return m !== null && requiredGroup(m, 1, HEADING).length <= level;
		});
		return (end === -1 ? rest : rest.slice(0, end)).join("\n");
	}
	return null;
}

/*
 * `**waived:** <why>` on an unticked criterion: checked, found not met, left
 * unticked on purpose. Reports without failing — the alternative is clearing a
 * red run by ticking something untrue. The reason is required; a bare marker
 * still fails.
 */
const WAIVER = /\*\*waived:?\*\*\s*(.*)$/i;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;

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
 * the issue's labels (#1640).
 * @param {string | null | undefined} body
 */
function unmetCriteria(body) {
	const section = criteriaSection(body);
	return section === null ? [] : taskItems(section).filter(isUnmet);
}

module.exports = { criteriaSection, isUnmet, taskItems, unmetCriteria };

if (require.main === module) {
	const fs = require("node:fs");
	const { parseOrExit } = require("./cli-args");
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node ticket-criteria.js unmet  (an issue body on stdin)",
		flags: {},
		commands: {
			unmet: {
				usage:
					"unmet: an issue body on stdin; prints its unticked, unwaived criteria as JSON",
			},
		},
	});
	const unmet = unmetCriteria(fs.readFileSync(0, "utf8")).map((i) => i.text);
	writeFd(1, `${JSON.stringify({ unmet })}\n`);
}
