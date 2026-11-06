/*
 * release-lag.js — the core of check-release-lag.js (#4448). Git is reached
 * only through the port the program hands in; nothing here reads a file.
 */

const { isTagRef } = require("./plugin-state.js");
const { RENDERED_FROM } = require("./release-tags.js");

/**
 * Warn once the newest release's source is more than this many days behind
 * `origin/main`. The longest gap between consecutive release sources from
 * v1.1.18 to v2.0.1 was ~6.3 days, so it fires only on a lag the release
 * habit has not produced before. Days, not commits: a burst of commits
 * inside seven days stays silent by design.
 */
const LAG_WARN_DAYS = 7;

/** scripts/spec-commits.js's width, so a source reads alike in both. */
const SHORT_SHA = 12;

const MAIN = "origin/main";
const DAY_S = 86_400;

/**
 * @param {{ref: string|null, source: {source?: string}|null}} pin
 */
function labelPin({ ref, source }) {
	if (source?.source === "directory") return "directory";
	if (isTagRef(ref)) return /** @type {string} */ (ref);
	if (ref) return `untagged ref ${ref}`;
	return "no pin";
}

/** @param {string[]} labels */
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
 * @typedef {{
 *   message: (rev: string) => string,
 *   hasCommit: (sha: string) => boolean,
 *   count: (range: string) => number,
 *   time: (rev: string) => number,
 * }} GitPort `time` is the committer date in epoch seconds.
 * @typedef {{kind: "no-source"}
 *   | {kind: "source-absent", source: string}
 *   | {kind: "measured", source: string, commits: number, days: number}} Reading
 * @typedef {{state: "UNREAD"|"BEHIND"|"WITHIN", finding: string|null, line: string}} Verdict
 */

/**
 * @param {GitPort} git
 * @param {string} tag
 * @param {string} tip `origin/main`'s commit
 * @returns {Reading}
 */
function readLag(git, tag, tip) {
	const source = RENDERED_FROM.exec(git.message(tag))?.[1];
	if (!source) return { kind: "no-source" };
	if (!git.hasCommit(source)) return { kind: "source-absent", source };
	/* Committer dates need not rise along history (a skewed clock, a rebase),
	 * so a tip dated before its ancestor reads 0, not a negative lag. */
	const days = Math.max(
		0,
		Math.floor((git.time(tip) - git.time(source)) / DAY_S),
	);
	return {
		kind: "measured",
		source,
		commits: git.count(`${source}..${tip}`),
		days,
	};
}

/**
 * @param {string} tag
 * @param {Reading} reading
 * @param {string} adopters formatAdopters' line
 * @returns {Verdict}
 */
function judgeLag(tag, reading, adopters) {
	if (reading.kind === "no-source")
		return {
			state: "UNREAD",
			finding: "LAG-UNREAD",
			line: `${tag}'s lag is unread: its message names no rendered-from source, so release-plugin.js did not cut it; the next release it cuts is read. ${adopters}`,
		};
	const short = reading.source.slice(0, SHORT_SHA);
	if (reading.kind === "source-absent")
		return {
			state: "UNREAD",
			finding: "LAG-UNREAD",
			line: `${tag}'s lag is unread: its source ${short} is not in this clone; \`git fetch origin\` brings it. ${adopters}`,
		};
	const line = `${tag} (from ${short}) is ${reading.commits} commit(s) and ${reading.days} day(s) behind ${MAIN}. ${adopters}`;
	if (reading.days <= LAG_WARN_DAYS)
		return { state: "WITHIN", finding: null, line };
	return {
		state: "BEHIND",
		finding: "RELEASE-LAG",
		line: `${line} Past the ${LAG_WARN_DAYS}-day threshold: no fix since reaches an adopter until a release is cut (\`node scripts/release-plugin.js\`).`,
	};
}

module.exports = {
	LAG_WARN_DAYS,
	MAIN,
	formatAdopters,
	judgeLag,
	labelPin,
	readLag,
};
