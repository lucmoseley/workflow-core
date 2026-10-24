#!/usr/bin/env node
/*
 * move-stray-doc-map-entries.js — put every `### B<n>` entry that has been
 * appended outside Section B back inside it, in id order (mantahostels#1352).
 *
 * Usage: node scripts/move-stray-doc-map-entries.js [<doc-map.md>]
 *
 * IT RELOCATES, IT NEVER REWRITES. Each stray's lines move verbatim; the only
 * bytes this writes that were not already there are the blank line and `---`
 * rule that separate entries. Verify with:
 *   diff <(grep -v '^---$' old | grep . | sort) <(grep -v '^---$' new | grep . | sort)
 *
 * CLAIM THE REGIONS FIRST. A script that writes a tracked doc is invisible to
 * the claim hook and must claim for itself (CLAUDE.md), and §B's regions are
 * per-entry, so this needs the whole set or none of it:
 *   node scripts/session-arbiter.js claim-all docs/doc-map.md#B198 ...
 * The stray ids are what `node scripts/check-doc-map.js` names under
 * STRAY-ENTRY. This script does not take them itself: the caller has to hold
 * them across its own commit, which outlives this process.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { parseOrExit } = require("./lib/cli-args");
const { figureHeadings, sectionBRange } = require("./lib/doc-map");

/* writeFd, never console: node buffers writes to a pipe and drops what is
 * still buffered at process.exit, and an agent reading this through Bash has a
 * pipe (docs/code-standards-base.md §N6). Human text goes to stderr. */
const say = (/** @type {string} */ text) => writeFd(2, `${text}\n`);

const { positionals } = parseOrExit(process.argv.slice(2), {
	usage: "Usage: node scripts/move-stray-doc-map-entries.js [<doc-map.md>]",
	max: 1,
});
const file = positionals[0] || "docs/doc-map.md";
const lines = fs.readFileSync(file, "utf8").split("\n");
const range = sectionBRange(lines);
if (!range) {
	say(`${file} has no '## Section B' heading — nothing to move into.`);
	process.exit(1);
}

/** A blank line or a `---` rule: what separates entries. */
const isSeparator = (/** @type {string} */ line) =>
	!line.trim() || line.trim() === "---";

/**
 * A block runs from its heading to just before the next heading of any level,
 * with trailing blank lines and a trailing `---` rule dropped — those are the
 * separator, not the entry.
 * @param {number} start
 */
const blockEnd = (start) => {
	const next = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l));
	const body = lines.slice(start + 1, next === -1 ? lines.length : next);
	return start + 2 + body.findLastIndex((l) => !isSeparator(l));
};

const headings = figureHeadings(lines).map((h) => ({
	id: Number(h.id.slice(1)),
	start: h.index,
	end: blockEnd(h.index),
	stray: h.stray,
}));

const strays = headings.filter((h) => h.stray);
if (strays.length === 0) {
	say(`${file}: no stray Section B entries.`);
	process.exit(0);
}
const inRange = headings.filter((h) => !h.stray);

/* Insertion point: the end of the last in-range entry with a lower id. §B's
 * headings are not globally id-ordered — an entry can sit between two lower ids — so
 * anchoring on the highest lower id places each stray in id order among its
 * neighbours without reordering anything already in range. */
/** @type {Map<number, typeof strays>} */
const insertions = new Map();
for (const stray of strays) {
	const below = inRange.filter((e) => e.id < stray.id).at(-1);
	const anchor = below === undefined ? range.start + 1 : below.end;
	const at = insertions.get(anchor);
	if (at) at.push(stray);
	else insertions.set(anchor, [stray]);
}
for (const list of insertions.values()) list.sort((a, b) => a.id - b.id);

/* Each stray's own lines, plus the separator run trailing it, so removing a
 * block leaves no double gap where it stood. */
/** @type {Set<number>} */
const removed = new Set();
for (const stray of strays) {
	for (let i = stray.start; i < stray.end; i++) removed.add(i);
	let i = stray.end;
	for (
		let line = lines[i];
		line !== undefined && isSeparator(line);
		line = lines[++i]
	)
		removed.add(i);
}

/** @type {string[]} */
const out = [];
const emit = (/** @type {number} */ at) => {
	for (const stray of insertions.get(at) || [])
		out.push("", ...lines.slice(stray.start, stray.end), "", "---");
};
for (const [i, line] of lines.entries()) {
	emit(i);
	if (!removed.has(i)) out.push(line);
}
emit(lines.length);

fs.writeFileSync(file, out.join("\n"));
say(
	`${file}: moved ${strays.length} entr(ies) into Section B — ` +
		strays.map((s) => `B${s.id}`).join(" "),
);
say(
	"Now refresh the budget report:\n" +
		"  node scripts/report-doc-map-budget.js",
);
