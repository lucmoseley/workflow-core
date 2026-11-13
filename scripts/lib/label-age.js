/*
 * label-age.js — when a label was last applied, read off an issue's timeline
 * (workflow-core#2693).
 */

/**
 * The fields read here off one event of an issue's timeline; a `labeled`
 * event carries all of them.
 * @typedef {{event?: string, label?: {name?: string}, created_at: string,
 *   actor?: {login?: string} | null}} TimelineEvent
 * @typedef {{ok: boolean, events?: TimelineEvent[], error?: string}} Timeline
 */

/**
 * How long `name` has been on, from the most recent `labeled` event carrying
 * it. Unknown where the label's start is unreadable — an unreachable timeline,
 * or, `unrecorded`, a label applied by a route the timeline does not record —
 * which is not the same as the label being absent.
 * @param {Timeline} timeline
 * @param {string} name
 * @param {number} [now] ms since the epoch; the wall clock where absent, so
 *   a caller asserting an age passes its own (§X9)
 * @returns {{unknown: true, unrecorded: boolean, error: string | undefined}|{unknown?: false, ageDays: number, appliedAt: string, appliedBy: string}}
 */
function labelAge(timeline, name, now = Date.now()) {
	if (!timeline.ok)
		return { unknown: true, unrecorded: false, error: timeline.error };
	const applied =
		(timeline.events ?? [])
			.filter((e) => e.event === "labeled" && e.label && e.label.name === name)
			.sort(
				(a, b) =>
					new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
			)[0] || null;
	if (!applied)
		return {
			unknown: true,
			unrecorded: true,
			error: "no `labeled` event on the timeline",
		};
	return {
		ageDays: (now - new Date(applied.created_at).getTime()) / 864e5,
		appliedAt: applied.created_at,
		appliedBy: applied.actor?.login || "unknown",
	};
}

module.exports = { labelAge };
