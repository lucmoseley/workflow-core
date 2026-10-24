/*
 * grouped-hits.js — the hit report the four superseded-value checkers print.
 * One copy, so the four reports cannot drift apart in layout (workflow-core#1984).
 */

/** @typedef {import("./check").CheckContext} Ctx */

/**
 * @template {{file: string, line: number, text: string}} H
 * @typedef {object} GroupedReport
 * @property {(hit: H) => string[]} keyOf which group a hit joins; groups print
 *   in first-hit order, and a group's finding key is its `tag` and these
 *   parts, tab-joined
 * @property {(groupCount: number) => string} summary the line above the groups
 * @property {(first: H, count: number) => {tag: string, message: string,
 *   data: object, heading: string}} groupFinding the WARN finding and the
 *   heading line for one group, read off its first hit
 * @property {string} footer
 */

/**
 * Print `hits` grouped by `keyOf`, one WARN per group. Prints nothing for no
 * hits.
 *
 * @template {{file: string, line: number, text: string}} H
 * @param {Ctx} ctx
 * @param {H[]} hits
 * @param {GroupedReport<H>} report
 */
function reportGroupedHits(
	ctx,
	hits,
	{ keyOf, summary, groupFinding, footer },
) {
	if (hits.length === 0) return;
	/** @type {Map<string, [H, ...H[]]>} */
	const groups = new Map();
	for (const h of hits) {
		const key = keyOf(h).join("\t");
		const group = groups.get(key);
		if (group) group.push(h);
		else groups.set(key, [h]);
	}
	ctx.say(summary(groups.size));
	for (const [key, group] of groups) {
		const { tag, message, data, heading } = groupFinding(
			group[0],
			group.length,
		);
		ctx.warn(tag, message, data, `${tag}\t${key}`);
		ctx.say(heading);
		for (const h of group) ctx.say(`  ${h.file}:${h.line}  ${h.text}`);
		ctx.say();
	}
	ctx.say(footer);
}

module.exports = { reportGroupedHits };
