const { isTagRef, sameRelease } = require("./plugin-state.js");
const { scriptPath } = require("./script-path.js");

// guess, #4448
const LAG_WARN_DAYS = 7;

// #892
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

/**
 * @typedef {{name: string, pin: string, installed: string|null}} Adopter
 */

/** @param {Adopter} adopter */
const isInstallOffPin = ({ pin, installed }) =>
	isTagRef(pin) && !sameRelease(installed, pin);

/** @param {string|null} installed */
const labelInstalled = (installed) =>
	installed === null ? "not installed" : `v${installed.replace(/^v/, "")}`;

/** @param {Adopter[]} adopters */
const listAdopters = (adopters) =>
	[...adopters]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((a) => `${a.name} ${a.pin} / ${labelInstalled(a.installed)}`)
		.join(", ");

/** @param {Adopter[]} adopters */
function formatAdopters(adopters) {
	if (adopters.length === 0) return "Adopters: no adopter checkout found.";
	return `Adopters, pin / installed: ${listAdopters(adopters)}.`;
}

/**
 * @param {Adopter[]} adopters
 * @returns {Finding|null}
 */
function judgeInstalls(adopters) {
	const off = adopters.filter(isInstallOffPin);
	if (off.length === 0) return null;
	return {
		finding: "INSTALL-OFF-PIN",
		line: `Install not at pin, pin / installed: ${listAdopters(off)}. The pinned release is not what runs there; each checkout's own session start names the commands that install it (${scriptPath("check-plugin-gap.js")}).`,
	};
}

/**
 * @typedef {{
 *   sourceOf: (tag: string) => string|null,
 *   hasCommit: (sha: string) => boolean,
 *   count: (range: string) => number,
 *   time: (rev: string) => number,
 * }} GitPort
 * @typedef {{kind: "no-source"}
 *   | {kind: "source-absent", source: string}
 *   | {kind: "measured", source: string, commits: number, days: number}} Reading
 * @typedef {{state: "UNREAD"|"BEHIND"|"WITHIN", finding: string|null, line: string}} Verdict
 * @typedef {{finding: string, line: string}} Finding
 */

/**
 * @param {GitPort} git
 * @param {string} tag
 * @param {string} tip
 * @returns {Reading}
 */
function readLag(git, tag, tip) {
	const source = git.sourceOf(tag);
	if (!source) return { kind: "no-source" };
	if (!git.hasCommit(source)) return { kind: "source-absent", source };
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
 * @param {string} adopters
 * @returns {Verdict}
 */
function judgeLag(tag, reading, adopters) {
	if (reading.kind === "no-source")
		return {
			state: "UNREAD",
			finding: "LAG-UNREAD",
			line: `${tag}'s lag is unread: its message names no rendered-from source, so ${scriptPath("release-plugin.js")} did not cut it; the next release it cuts is read. ${adopters}`,
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
		line: `${line} Past the ${LAG_WARN_DAYS}-day threshold: no fix since reaches an adopter until a release is cut (\`node ${scriptPath("release-plugin.js")}\`).`,
	};
}

module.exports = {
	LAG_WARN_DAYS,
	MAIN,
	formatAdopters,
	judgeInstalls,
	judgeLag,
	labelPin,
	readLag,
};
