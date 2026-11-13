/*
 * doc-map-gate-report.js — what the pre-commit doc-map gate makes of the
 * checker's held report on a run it lets through (#5155): the blocks it
 * replays, and the untracked-entry refusal (mantahostels#1300, mantahostels#1403).
 *
 * The report is held because the check always prints a long report-only
 * section. Some findings survive a green run, and holding the output hid them:
 *   - a register row or a Section C route whose target is on disk but absent
 *     from this commit's index. mantahostels#1193 ruled that a WARN, and it stays one
 *     for an item this commit inherited. But on the sweeps' clean checkout the
 *     file is not on disk either, so the item reads as DEAD there and FAILs.
 *     The commit that ADDS the item is the one that can still fix it, so an
 *     added item is refused;
 *   - assertion 22's growth WARN (mantahostels#2050) and assertion 24's dropped-marker
 *     WARN (mantahostels#2227), which compare against the parent, so the sweeps' clean
 *     checkout never sees them;
 *   - assertion 23's malformed-marker WARN (mantahostels#2124), which CI does see, but
 *     only after the push.
 * Each is replayed as its block alone, never the whole report, and the WARNs
 * never refuse.
 *
 * THE MARKERS MATCH check-doc-map.js's OWN WORDING, and the slice cuts on
 * reportFault's shape after it: message, indented items, a blank line, one
 * advice line. precommit-doc-map-gate.test.ts pins both against the real
 * checker. Each untracked block has its own marker: one matching both would
 * slice whichever came first and judge a route's `C36 → path` item against
 * Section A's wording.
 *
 * A CORE (base §T7): it performs no I/O. HEAD's map is handed in.
 */

const { substituted } = require("./precommit-gate-verdicts.js");

/** The WARN blocks replayed alone, in replay order: assertions 22, 23, 24. */
const REPLAY_MARKERS = [
	/marked over cap by ruling grew in/,
	/look like an over-cap marker but do not parse as one:$/,
	/lost the marker the baseline carried:$/,
];

/** The untracked blocks, Section A's first. */
const UNTRACKED_BLOCKS = [
	{
		marker: /register entr.* not yet tracked by git:$/,
		noun: "Section A row(s)",
		fix: "name the file in this commit's pathspec too, or drop the row until it lands.",
	},
	{
		marker: /Section C route path.* not yet tracked by git:$/,
		noun: "Section C route(s)",
		fix: "name the file in this commit's pathspec too, or drop the route until it lands.",
	},
];

/**
 * The block of `report` opening on the first line matching `marker`, through
 * the line after its first blank line, or "" where no line matches.
 * @param {string} report
 * @param {RegExp} marker
 */
function sliceBlock(report, marker) {
	const lines = report.split("\n");
	const start = lines.findIndex((l) => marker.test(l));
	if (start === -1) return "";
	const blank = lines.findIndex((l, i) => i >= start && l === "");
	const end = blank === -1 ? lines.length : blank + 2;
	return substituted(lines.slice(start, end).join("\n"));
}

/**
 * A block's items: its lines indented two spaces, the indent cut.
 * @param {string} block
 */
const itemsOf = (block) =>
	block
		.split("\n")
		.filter((l) => l.startsWith("  "))
		.map((l) => l.slice(2));

/**
 * The items `headMap` does not name. A route item reads "C36 → docs/x.md", and
 * only its path is asked of HEAD: the id is this commit's own invention as
 * often as not, so matching the whole item would read every route as new.
 * Inherited means the path appears anywhere in HEAD's map, so anything
 * ambiguous reads as inherited and warns rather than blocking a commit that did
 * not create it. An empty map (none in HEAD, or unreadable) names nothing new.
 * @param {string[]} items
 * @param {string} headMap
 */
function addedItems(items, headMap) {
	if (headMap === "") return [];
	return items.filter((item) => {
		if (item === "") return false;
		const at = item.lastIndexOf(" → ");
		const needle = at === -1 ? item : item.slice(at + " → ".length);
		return !headMap.includes(needle);
	});
}

/**
 * One untracked block's replay, and the refusal where this commit adds an item.
 * @param {string} report
 * @param {{ marker: RegExp, noun: string, fix: string }} block
 * @param {string} headMap
 * @returns {{ text: string, exit: number }}
 */
function untrackedVerdict(report, block, headMap) {
	const slice = sliceBlock(report, block.marker);
	if (slice === "") return { text: "", exit: 0 };
	const added = addedItems(itemsOf(slice), headMap);
	if (added.length > 0)
		return {
			text: [
				slice,
				`pre-commit: this commit adds the doc-map ${block.noun} below and not the file(s) they name:`,
				...added.map((item) => `  ${item}`),
				"  The sweeps run a clean checkout, where the file is not on disk either — so it reads as DEAD there and FAILs (mantahostels#1300, mantahostels#1403).",
				`  Fix: ${block.fix}`,
				"",
			].join("\n"),
			exit: 1,
		};
	return {
		text: `${slice}\npre-commit: left as they are, the ${block.noun} above reach the scheduled sweeps as DEAD, which FAILs there (mantahostels#1300, mantahostels#1403).\n`,
		exit: 0,
	};
}

/**
 * Everything the gate prints from a held report it let through: the three WARN
 * blocks, then the two untracked blocks, stopping at the first refusal.
 * @param {string} report the checker's combined output, trailing newlines cut
 * @param {string} headMap HEAD's docs/doc-map.md, or "" where unreadable
 * @returns {{ text: string, exit: number }}
 */
function greenReport(report, headMap) {
	let text = "";
	for (const marker of REPLAY_MARKERS) {
		const slice = sliceBlock(report, marker);
		if (slice !== "") text += `${slice}\n`;
	}
	for (const block of UNTRACKED_BLOCKS) {
		const verdict = untrackedVerdict(report, block, headMap);
		text += verdict.text;
		if (verdict.exit !== 0) return { text, exit: verdict.exit };
	}
	return { text, exit: 0 };
}

/**
 * Whether `report` holds an untracked block, the one thing HEAD's map is read
 * to judge: a report without one costs no HEAD read.
 * @param {string} report
 */
const readsHeadMap = (report) =>
	UNTRACKED_BLOCKS.some((block) => sliceBlock(report, block.marker) !== "");

module.exports = {
	addedItems,
	greenReport,
	readsHeadMap,
	itemsOf,
	REPLAY_MARKERS,
	sliceBlock,
	UNTRACKED_BLOCKS,
	untrackedVerdict,
};
