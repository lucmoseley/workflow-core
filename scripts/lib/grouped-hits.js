/** @typedef {import("./check").Ctx} Ctx */

/**
 * @template {{file: string, line: number, text: string}} H
 * @typedef {object} GroupedReport
 * @property {(hit: H) => string[]} keyOf
 * @property {(groupCount: number) => string} summary
 * @property {(first: H, count: number) => {tag: string, message: string, data: object, heading: string}} groupFinding
 * @property {string} footer
 */

/**
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
