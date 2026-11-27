const WATCH_CLOSED_LABEL = "watch:closed";

/** @param {{labels?: ({name?: string}|string)[]}} issue */
const isClosedWatch = (issue) =>
	(issue.labels ?? []).some(
		(l) => (typeof l === "string" ? l : l.name) === WATCH_CLOSED_LABEL,
	);

module.exports = { WATCH_CLOSED_LABEL, isClosedWatch };
