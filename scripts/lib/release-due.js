const { TAG_RE, newestTag } = require("./release-tags.js");
const { parseSteps } = require("./migration-note.js");

const CUT_TITLE = "Release cut due";
const OWED_TYPES = ["act", "choice"];

/**
 * @typedef {{ note: string, version: string, text: string }} NoteFile
 * @typedef {{ note: string, owedSteps: number }} OwedNote
 * @typedef {{ tag: string, cutSec: number, notes: NoteFile[] }} CutReading
 * @typedef {{ due: boolean, why: string }} CutVerdict
 */

/**
 * @param {string} tag
 * @param {NoteFile[]} notes
 * @returns {OwedNote[]}
 */
function selectOwed(tag, notes) {
	/** @type {OwedNote[]} */
	const owed = [];
	for (const { note, version, text } of notes) {
		if (!TAG_RE.test(version) || version === tag) continue;
		if (newestTag([tag, version]) !== version) continue;
		const owedSteps = parseSteps(text).filter((s) =>
			OWED_TYPES.includes(s.type),
		).length;
		if (owedSteps > 0) owed.push({ note, owedSteps });
	}
	return owed;
}

/**
 * @param {Pick<CutReading, "tag" | "notes">} reading
 * @param {string} [because]
 * @returns {CutVerdict}
 */
function judgeCut({ tag, notes }, because) {
	if (because) return { due: true, why: because };
	const owed = selectOwed(tag, notes);
	if (owed.length === 0)
		return {
			due: false,
			why: `no migration note newer than ${tag} carries an [act] or [choice] step`,
		};
	const listed = owed.map((o) => `${o.note} (${o.owedSteps})`).join(", ");
	return {
		due: true,
		why: `migration notes newer than ${tag} owe adopters [act] or [choice] steps: ${listed}`,
	};
}

module.exports = { CUT_TITLE, judgeCut };
