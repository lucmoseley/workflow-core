/*
 * presence.js — whether the founder is at the laptop (workflow-core#2004, spec workflow-core#1995):
 * present means he typed a prompt in some session, on any seat, within the
 * last PRESENT_WINDOW_MS. The refill loop keeps one slot free for him while he
 * is present.
 *
 * ONE MARKER PER MACHINE, `~/.claude/.founder-presence` (lib/machine-marker.js),
 * because a per-checkout or per-seat file would miss his prompts in every
 * other repo and plan. `WFC_PRESENCE_MARKER` overrides it, so a test never
 * touches the machine's real marker.
 *
 * Caller: `lastTypedAt`, scripts/refill-loop.js's tick (workflow-core#2012)
 */

const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { machineMarkerPath } = require("./machine-marker.js");

/* Untraced: spec workflow-core#1995's value, not a measurement. */
const PRESENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * @param {Record<string, string | undefined>} env
 * @throws as lib/machine-marker.js's machineMarkerPath
 */
const markerPath = (env) =>
	env.WFC_PRESENCE_MARKER || machineMarkerPath(".founder-presence", env);

/**
 * Record a typed prompt at `now`, atomically.
 * @param {Date} now
 * @param {Record<string, string | undefined>} [env]
 */
function markPresent(now, env = process.env) {
	writeFileAtomic(markerPath(env), `${now.toISOString()}\n`);
}

/**
 * The last typed prompt's time in ms, or null where none is recorded or the
 * marker is unreadable.
 * @param {Record<string, string | undefined>} [env]
 * @returns {number|null}
 */
function lastTypedAt(env = process.env) {
	try {
		const at = Date.parse(fs.readFileSync(markerPath(env), "utf8").trim());
		return Number.isNaN(at) ? null : at;
	} catch {
		/* Fails open to no record, which reads as away (workflow-core#2004). */
		return null;
	}
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
	lastTypedAt,
	markPresent,
	presenceAt,
};
