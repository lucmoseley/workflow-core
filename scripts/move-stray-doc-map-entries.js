#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { parseOrExit } = require("./lib/cli-args");
const { figureHeadings, idNumber, sectionBRange } = require("./lib/doc-map");

const say = (/** @type {string} */ text) => writeFd(2, `${text}\n`);

const { positionals } = parseOrExit(process.argv.slice(2), {
	usage: `Usage: node ${scriptPath("move-stray-doc-map-entries.js")} [<doc-map.md>]`,
	max: 1,
});
const file = positionals[0] || "docs/doc-map.md";
const lines = fs.readFileSync(file, "utf8").split("\n");
const range = sectionBRange(lines);
if (!range) {
	say(`${file} has no '## Section B' heading — nothing to move into.`);
	process.exit(1);
}

const isSeparator = (/** @type {string} */ line) =>
	!line.trim() || line.trim() === "---";

/** @param {number} start */
const blockEnd = (start) => {
	const next = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l));
	const body = lines.slice(start + 1, next === -1 ? lines.length : next);
	return start + 2 + body.findLastIndex((l) => !isSeparator(l));
};

const headings = figureHeadings(lines).map((h) => ({
	id: idNumber(h.id),
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
		`  node ${scriptPath("report-doc-map-budget.js")}`,
);
