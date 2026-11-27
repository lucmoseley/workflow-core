const { formatSide, parseHeader } = require("./hunk-header.js");

/**
 * @typedef {{header: string, newStart: number, lines: string[], noEol: boolean}} NewSide
 * @typedef {{section: string, file: string}} PatchSection
 * @typedef {{text: string, blob: string, modes: string[]}} TreeFile
 */

/**
 * @param {string} section
 * @returns {NewSide[]}
 */
function parseNewSides(section) {
	/** @type {NewSide[]} */
	const sides = [];
	const lines = section.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) break;
		const h = parseHeader(line);
		if (!h) {
			i++;
			continue;
		}
		const body = parseBody(lines, i + 1, h);
		i = body.end + 1;
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
 * @param {string} section
 * @param {TreeFile|null} tree
 * @returns {string|null}
 */
function notInTree(section, tree) {
	if (/^deleted file mode /m.test(section))
		return tree === null ? null : "deleted, still on disk";
	const created = /^(?:rename from|new file mode) /m.test(section);
	const newMode = /^new (?:file )?mode (\d+)$/m.exec(section)?.[1];
	const binary = /^GIT binary patch$/m.test(section);
	if (tree === null)
		return parseNewSides(section).length > 0 || created || newMode || binary
			? "not on disk"
			: null;
	if (newMode && !tree.modes.includes(newMode))
		return `mode ${tree.modes.join(" or ")}, the patch gives ${newMode}`;
	if (binary) {
		const post = /^index [0-9a-f]+\.\.([0-9a-f]+)/m.exec(section)?.[1];
		if (!post) return "a binary section with no index line to check it by";
		if (!tree.blob.startsWith(post))
			return `blob ${tree.blob.slice(0, post.length)}, the patch gives ${post}`;
	}
	const missing = missingHunks(section, tree.text);
	return missing.length > 0
		? `lacks the lines of hunk ${missing.join(", ")}`
		: null;
}

module.exports = { notInTree };
