/*
 * label-age.js — when a label was last applied, read off an issue's timeline.
 * Callers: scripts/pick-next.js and scripts/file-morning-review.js (#2693).
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
 * it. `null` where the label's start is unreadable — an unreachable timeline,
 * or a label applied by a route the timeline does not record — which is not the
 * same as the label being absent.
 * @param {Timeline} timeline
 * @param {string} name
 * @returns {{unknown: true, error: string | undefined}|{unknown?: false, ageDays: number, appliedAt: string, appliedBy: string}}
 */
function labelAge(timeline, name) {
	if (!timeline.ok) return { unknown: true, error: timeline.error };
	const applied =
		(timeline.events ?? [])
			.filter((e) => e.event === "labeled" && e.label && e.label.name === name)
			.sort(
				(a, b) =>
					new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
			)[0] || null;
	if (!applied)
		return { unknown: true, error: "no `labeled` event on the timeline" };
	return {
		ageDays: (Date.now() - new Date(applied.created_at).getTime()) / 864e5,
		appliedAt: applied.created_at,
		appliedBy: applied.actor?.login || "unknown",
	};
}

module.exports = { labelAge };
