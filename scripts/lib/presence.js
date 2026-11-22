const os = require("node:os");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDirFrom, seatDir } = require("./config-dir.js");
const { readText } = require("./file-read.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { planSeatsOf } = require("./refill-seats.js");

// guess, #1995
const PRESENT_WINDOW_MS = 30 * 60 * 1000;

/** @param {Record<string, string | undefined>} env */
const markerPath = (env) =>
	env.WFC_PRESENCE_MARKER || machineMarkerPath(".founder-presence", env);

/**
 * @param {Date} now
 * @param {Record<string, string | undefined>} [env]
 */
function markPresent(now, env = process.env) {
	const home = env.HOME || os.homedir();
	const seat = seatDir(configDirFrom(env.CLAUDE_CONFIG_DIR, home), home);
	writeFileAtomic(markerPath(env), `${now.toISOString()}\n${seat}\n`);
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{at: number|null, recorded: string}}
 */
function readMarker(env) {
	const read = readText(markerPath(env));
	const text = read.state === "read" ? read.data : "";
	const [time = "", recorded = ""] = text.split("\n").map((l) => l.trim());
	const at = Date.parse(time);
	return { at: Number.isNaN(at) ? null : at, recorded };
}

/**
 * @param {import("./refill-seats.js").SeatList} list
 * @param {Record<string, string | undefined>} [env]
 * @returns {string|null}
 */
function readLastTypedSeat(list, env = process.env) {
	const { recorded } = readMarker(env);
	const listed =
		list.errors.length === 0 &&
		planSeatsOf(list.seats).some((s) => s.dir === recorded);
	return recorded && listed ? recorded : null;
}

/** @param {Record<string, string | undefined>} [env] */
const readLastTypedAt = (env = process.env) => readMarker(env).at;

/**
 * @param {number|null} lastTyped
 * @param {Date} now
 * @returns {"present"|"away"}
 */
function presenceAt(lastTyped, now) {
	if (lastTyped === null) return "away";
	const since = now.getTime() - lastTyped;
	return since >= 0 && since < PRESENT_WINDOW_MS ? "present" : "away";
}

/**
 * @param {number|null} switchedAt
 * @param {number|null} lastTyped
 * @param {Date} now
 */
function isAbsentSinceSwitch(switchedAt, lastTyped, now) {
	const lastSeen =
		switchedAt === null
			? lastTyped
			: Math.max(lastTyped ?? switchedAt, switchedAt);
	return presenceAt(lastSeen, now) === "away";
}

module.exports = {
	isAbsentSinceSwitch,
	readLastTypedSeat,
	readLastTypedAt,
	markPresent,
	presenceAt,
};
