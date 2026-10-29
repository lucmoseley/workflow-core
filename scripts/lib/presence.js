/*
 * presence.js — whether the founder is at the laptop (#2004, spec #1995):
 * present means he typed a prompt in some session, on any seat, within the
 * last PRESENT_WINDOW_MS. The refill loop keeps one slot free for him while he
 * is present.
 *
 * ONE MARKER PER MACHINE, `~/.claude/.founder-presence` (lib/machine-marker.js),
 * because a per-checkout or per-seat file would miss his prompts in every
 * other repo and plan. `WFC_PRESENCE_MARKER` overrides it, so a test never
 * touches the machine's real marker.
 *
 * The marker also names the seat he typed on (#3731): the typing session's
 * config dir, in the seat file's form, so the refill loop can launch where he
 * is watching. Line one is the time, line two the seat.
 *
 * Caller: `readLastTyped`, lib/refill-tick.js's tick (#2012)
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDirFrom } = require("./config-dir.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { homeDir } = require("./refill-repos.js");
const { seatDir } = require("./refill-seats.js");

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
	const seat = seatDir(configDirFrom(env.CLAUDE_CONFIG_DIR), homeDir());
	writeFileAtomic(markerPath(env), `${now.toISOString()}\n${seat}\n`);
}

/**
 * The last typed prompt's time in ms and the plan seat it was typed on. `at`
 * is null where no time is recorded or the marker is unreadable; `seat` is
 * null where none is recorded or it is not a plan seat `list` declares.
 * @param {import("./refill-seats.js").SeatList} list
 * @param {Record<string, string | undefined>} [env]
 * @returns {{at: number|null, seat: string|null}}
 */
function readLastTyped(list, env = process.env) {
	let text;
	try {
		text = fs.readFileSync(markerPath(env), "utf8");
	} catch {
		/* Fails open to no record, which reads as away (#2004). */
		return { at: null, seat: null };
	}
	const [time = "", recorded = ""] = text.split("\n").map((l) => l.trim());
	const at = Date.parse(time);
	const listed =
		list.errors.length === 0 &&
		list.seats.some((s) => s.kind === "plan" && s.dir === recorded);
	return {
		at: Number.isNaN(at) ? null : at,
		seat: recorded && listed ? recorded : null,
	};
}

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
	markPresent,
	presenceAt,
};
