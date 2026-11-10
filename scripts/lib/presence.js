/*
 * presence.js — whether the founder is at the laptop (#2004, spec #1995):
 * present means he typed a prompt in some session, on any seat, within the
 * last PRESENT_WINDOW_MS.
 *
 * ONE MARKER PER MACHINE, `~/.claude/.founder-presence` (lib/machine-marker.js),
 * because a per-checkout or per-seat file would miss his prompts in every
 * other repo and plan. `WFC_PRESENCE_MARKER` overrides it, so a test never
 * touches the machine's real marker.
 *
 * The marker also names the seat he typed on (#3731): the typing session's
 * config dir, in the seat file's form. Line one is the time, line two the seat.
 */

const os = require("node:os");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDirFrom, seatDir } = require("./config-dir.js");
const { readText } = require("./file-read.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { planSeatsOf } = require("./refill-seats.js");

/* Untraced: spec #1995's value, not a measurement. */
const PRESENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} env
 * @throws as lib/machine-marker.js's machineMarkerPath
 */
const markerPath = (env) =>
	env.WFC_PRESENCE_MARKER || machineMarkerPath(".founder-presence", env);

/**
 * Record a prompt typed at `now` in the session `env` belongs to, atomically.
 * @param {Date} now
 * @param {Record<string, string | undefined>} [env]
 */
function markPresent(now, env = process.env) {
	const home = env.HOME || os.homedir();
	const seat = seatDir(configDirFrom(env.CLAUDE_CONFIG_DIR, home), home);
	writeFileAtomic(markerPath(env), `${now.toISOString()}\n${seat}\n`);
}

/**
 * The marker's time in ms, null where none is recorded, and the seat it names.
 * @param {Record<string, string | undefined>} env
 * @returns {{at: number|null, recorded: string}}
 */
function readMarker(env) {
	/* Fails open to no record, which reads as away (#2004). */
	const read = readText(markerPath(env));
	const text = read.state === "read" ? read.data : "";
	const [time = "", recorded = ""] = text.split("\n").map((l) => l.trim());
	const at = Date.parse(time);
	return { at: Number.isNaN(at) ? null : at, recorded };
}

/**
 * The last typed prompt's time in ms and the plan seat it was typed on. `at`
 * is null where no time is recorded or the marker is unreadable; `seat` is
 * null where none is recorded, it is not a plan seat `list` declares, or the
 * seat file refuses, as readConfiguredSeats reads it.
 * @param {import("./refill-seats.js").SeatList} list
 * @param {Record<string, string | undefined>} [env]
 * @returns {{at: number|null, seat: string|null}}
 */
function readLastTyped(list, env = process.env) {
	const { at, recorded } = readMarker(env);
	const listed =
		list.errors.length === 0 &&
		planSeatsOf(list.seats).some((s) => s.dir === recorded);
	return { at, seat: recorded && listed ? recorded : null };
}

/**
 * The last typed prompt's time in ms, null as readLastTyped's `at` is.
 * @param {Record<string, string | undefined>} [env]
 */
const readLastTypedAt = (env = process.env) => readMarker(env).at;

/**
 * "present" where the last typed prompt falls within the window before `now`,
 * else "away". No record reads as away: the loop then fills every slot.
 * @param {number|null} lastTyped ms
 * @param {Date} now
 * @returns {"present"|"away"}
 */
function presenceAt(lastTyped, now) {
	if (lastTyped === null) return "away";
	const since = now.getTime() - lastTyped;
	return since >= 0 && since < PRESENT_WINDOW_MS ? "present" : "away";
}

module.exports = {
	readLastTyped,
	readLastTypedAt,
	markPresent,
	presenceAt,
};
