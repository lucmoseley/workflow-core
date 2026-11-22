const {
	REPLAY_MARKERS,
	UNTRACKED_BLOCKS,
} = require("./doc-map-gate-markers.js");
const { substituted } = require("./precommit-gate-verdicts.js");

/**
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

/** @param {string} block */
const itemsOf = (block) =>
	block
		.split("\n")
		.filter((l) => l.startsWith("  "))
		.map((l) => l.slice(2));

/**
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
 * @param {string} report
 * @param {string} headMap
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

/** @param {string} report */
const hasUntrackedBlock = (report) =>
	UNTRACKED_BLOCKS.some((block) => sliceBlock(report, block.marker) !== "");

module.exports = { greenReport, hasUntrackedBlock };
