const CUT_TITLE = "Release cut due";

/**
 * @typedef {{ note: string, steps: number }} OwedNote
 * @typedef {{ tag: string, cutSec: number, owed: OwedNote[] }} CutReading
 * @typedef {{ due: boolean, why: string }} CutVerdict
 */

/**
 * @param {Pick<CutReading, "tag" | "owed">} reading
 * @returns {CutVerdict}
 */
function judgeCut({ tag, owed }) {
	if (owed.length === 0)
		return {
			due: false,
			why: `no migration note newer than ${tag} carries an [act] or [choice] step`,
		};
	const notes = owed.map((o) => `${o.note} (${o.steps})`).join(", ");
	return {
		due: true,
		why: `migration notes newer than ${tag} owe adopters [act] or [choice] steps: ${notes}`,
	};
}

module.exports = { CUT_TITLE, judgeCut };
