/*
 * patch-in-tree.js — whether a patch's post-image is already in the calling
 * tree's files (#4338). commit-paths.js --patch never writes the working
 * tree, so a patch cut in another worktree commits lines this tree lacks, and
 * git then shows this tree's files as that commit reversed.
 *
 * Residual: a hunk that only deletes lines is not checked, since its
 * post-image is empty and absence cannot be tested by position without
 * refusing the deletion of one of two identical adjacent lines. A deleted
 * file is checked whole, and a rename's new name; its old name may stay on
 * disk, holding a neighbour's edits (#3723).
 */

const { formatSide, parseHeader } = require("./hunk-header.js");

/**
 * @typedef {{header: string, newStart: number, lines: string[], noEol: boolean}} NewSide
 * @typedef {{section: string, file: string}} PatchSection one `diff --git`
 *   section of a patch and the top-level file it touches
 */

/**
 * Each hunk's new side — its context and added lines, in order — with the
 * line it starts at in the file it was cut from, and whether its last line
 * carries `\ No newline at end of file`.
 * @param {string} section one `diff --git` section of a patch
 * @returns {NewSide[]}
 */
function parseNewSides(section) {
	/** @type {NewSide[]} */
	const sides = [];
	const lines = section.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;
		const h = parseHeader(line);
		if (!h) continue;
		const body = parseBody(lines, i + 1, h);
		i = body.end;
		if (h.newCount > 0)
			sides.push({
				header: `+${formatSide(h.newStart, h.newCount)}`,
				newStart: h.newStart,
				lines: body.newSide,
				noEol: body.noEol,
			});
	}
	return sides;
}

/**
 * The new-side lines of the hunk body starting at `from`, whether a
 * no-newline marker follows the last of them, and the index of the body's
 * last line. A marker qualifies the line before it, so one after a removed
 * line is the old side's.
 * @param {string[]} lines
 * @param {number} from
 * @param {{oldCount: number, newCount: number}} h
 */
function parseBody(lines, from, h) {
	let oldLeft = h.oldCount;
	let newLeft = h.newCount;
	/** @type {string[]} */
	const newSide = [];
	let noEol = false;
	let last = "";
	let i = from;
	for (; oldLeft > 0 || newLeft > 0 || lines[i]?.[0] === "\\"; i++) {
		const line = lines[i];
		if (line === undefined) break;
		if (line[0] === "\\") {
			if (last !== "-") noEol = true;
			continue;
		}
		last = line[0] ?? "";
		if (line[0] !== "+") oldLeft--;
		if (line[0] === "-") continue;
		newLeft--;
		newSide.push(line.slice(1));
	}
	return { newSide, noEol, end: i - 1 };
}

/**
 * The hunks of `section` whose new side `text` does not hold at the line the
 * cut gives it, its final newline included where it reaches the file's end,
 * each named by its new-side range. Exact, never searched for: a one-line
 * hunk adding `}` would match somewhere in nearly any file.
 * @param {string} section
 * @param {string} text
 * @returns {string[]}
 */
function missingHunks(section, text) {
	const file = text.split("\n");
	const endsNewline = file.at(-1) === "";
	if (endsNewline) file.pop();
	/** @type {(s: NewSide) => boolean} */
	const endMatches = (s) =>
		s.newStart - 1 + s.lines.length === file.length
			? s.noEol !== endsNewline
			: !s.noEol;
	return parseNewSides(section)
		.filter(
			(s) =>
				!endMatches(s) ||
				s.lines.some((line, k) => file[s.newStart - 1 + k] !== line),
		)
		.map((s) => s.header);
}

/**
 * Why this tree does not hold `section`'s post-image for `file`, or null
 * where it does. `readText` gives a top-level path's text as git would store
 * it, or null where nothing is on disk there.
 * @param {PatchSection} s
 * @param {(file: string) => string|null} readText
 * @returns {string|null}
 */
function notInTree({ section, file }, readText) {
	const text = readText(file);
	if (/^deleted file mode /m.test(section))
		return text === null ? null : "deleted, still on disk";
	const created = /^(?:rename from|new file mode) /m.test(section);
	if (text === null)
		return parseNewSides(section).length > 0 || created ? "not on disk" : null;
	const missing = missingHunks(section, text);
	return missing.length > 0
		? `lacks the lines of hunk ${missing.join(", ")}`
		: null;
}

module.exports = { notInTree };
