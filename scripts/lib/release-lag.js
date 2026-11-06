/*
 * release-lag.js — the judging behind check-release-lag.js (#4448): which
 * label an adopter's pin counts under, and what a lag reading says. Pure;
 * the program reads git and the adopters' settings and hands them in.
 */

/**
 * Warn once the newest release's source is more than this many days behind
 * `origin/main`. The two longest gaps between consecutive release sources
 * from v1.1.18 to v2.0.1 were ~6.3 days (v1.3.8 to v1.3.9, v2.0.0 to v2.0.1),
 * so it fires only on a lag the release habit has not produced before. Days,
 * not commits: the commits per release ran from 2 to 1,729 over the same
 * span, so a burst of commits inside seven days stays silent by design.
 */
const LAG_WARN_DAYS = 7;

/** How a source is quoted in the reading: the width the tracker cites one at. */
const SHORT_SHA = 9;

const MAIN = "origin/main";

/**
 * The label one adopter's pin counts under.
 * @param {{ref: string|null, source: {source?: string}|null}} pin
 * @param {(ref: string|null) => boolean} isTagRef
 */
function labelPin({ ref, source }, isTagRef) {
	if (source?.source === "directory") return "directory";
	if (ref !== null && isTagRef(ref)) return ref;
	if (ref) return `untagged ref ${ref}`;
	return "no pin";
}

/**
 * `Adopters per tag: v2.0.1 ×5.` from each adopter's label.
 * @param {string[]} labels
 */
function formatAdopters(labels) {
	if (labels.length === 0)
		return "Adopters per tag: no adopter checkout found.";
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	const parts = [...counts]
		.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
		.map(([label, n]) => `${label} ×${n}`);
	return `Adopters per tag: ${parts.join(", ")}.`;
}

/**
 * @typedef {{kind: "no-source"}
 *   | {kind: "source-absent", source: string}
 *   | {kind: "measured", source: string, commits: number, days: number}} Reading
 * @typedef {{state: "UNREAD"|"BEHIND"|"WITHIN", line: string}} Verdict
 */

/**
 * What the newest tag's lag reading says, with the adopters line appended.
 * @param {string} tag
 * @param {Reading} reading
 * @param {string} adopters formatAdopters' line
 * @returns {Verdict}
 */
function judgeLag(tag, reading, adopters) {
	if (reading.kind === "no-source")
		return {
			state: "UNREAD",
			line: `${tag}'s lag is unread: its message names no rendered-from source, so release-plugin.js did not cut it; the next release it cuts is read. ${adopters}`,
		};
	const short = reading.source.slice(0, SHORT_SHA);
	if (reading.kind === "source-absent")
		return {
			state: "UNREAD",
			line: `${tag}'s lag is unread: its source ${short} is not in this clone; \`git fetch origin\` brings it. ${adopters}`,
		};
	const line = `${tag} (from ${short}) is ${reading.commits} commit(s) and ${reading.days} day(s) behind ${MAIN}. ${adopters}`;
	if (reading.days <= LAG_WARN_DAYS) return { state: "WITHIN", line };
	return {
		state: "BEHIND",
		line: `${line} Past the ${LAG_WARN_DAYS}-day threshold: no fix since reaches an adopter until a release is cut (\`node scripts/release-plugin.js\`).`,
	};
}

module.exports = { LAG_WARN_DAYS, MAIN, formatAdopters, judgeLag, labelPin };
