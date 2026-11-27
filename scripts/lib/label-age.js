/**
 * @typedef {{event?: string, label?: {name?: string}, created_at: string,
 *   actor?: {login?: string} | null}} TimelineEvent
 * @typedef {{ok: boolean, events?: TimelineEvent[], error?: string}} Timeline
 */

/**
 * @param {Timeline} timeline
 * @param {string} name
 * @param {number} [now]
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
