const { requiredGroup } = require("./regex-group.js");

const CRITERIA_HEADING = /^\s{0,3}(#{1,6})\s+acceptance(?:\s+criteria)?\s*$/i;
const HEADING = /^\s{0,3}(#{1,6})\s+/;

/** @param {readonly string[]} lines @returns {[number, number]|null} */
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

const WAIVER = /\*\*waived:?\*\*\s*(\S.*|)$/i;
const TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s*(\S.*|)$/;

/** @param {string} md */
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

/** @param {{ticked: boolean, waived: boolean}} item */
const isUnmet = (item) => !item.ticked && !item.waived;

/** @param {string | null | undefined} body */
function unmetCriteria(body) {
	const section = criteriaSection(body);
	return section === null ? [] : taskItems(section).filter(isUnmet);
}

/** @param {string} body @param {string} criterion @returns {string} */
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
 * @param {number} n
 * @param {string} body
 * @param {string} criterion
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
