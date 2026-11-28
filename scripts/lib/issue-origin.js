const ORIGINS = /** @type {const} */ ([
	"wayfinder",
	"to-spec",
	"to-tickets-child",
	"code-review",
	"concision-pass",
	"ruling-impl",
	"found-in-passing",
	"follow-up",
	"measure-census",
	"triage",
	"audit",
	"incident",
	"heresy-sweep",
	"architecture-scan",
	"retro",
	"ci-red",
	"lander-script",
	"orphaned-edit-script",
	"morning-review-script",
	"release-bump",
	"repo-checks-script",
	"disk-watch-script",
	"stale-run",
	"founder",
]);

const SCRIPT_ORIGINS = /** @type {readonly string[]} */ ([
	"lander-script",
	"orphaned-edit-script",
	"ci-red",
	"incident",
	"morning-review-script",
	"release-bump",
	"repo-checks-script",
	"disk-watch-script",
	"stale-run",
]);

const ORIGIN_PREFIX = "origin:";

/** @param {typeof ORIGINS[number]} origin */
const originLabel = (origin) => `${ORIGIN_PREFIX}${origin}`;

/** @param {string} v @returns {boolean} */
const isOrigin = (v) => /** @type {readonly string[]} */ (ORIGINS).includes(v);

/** @param {string | null} origin */
const isScriptOrigin = (origin) =>
	origin !== null && SCRIPT_ORIGINS.includes(origin);

/**
 * @param {string[]} labels
 * @returns {string|null}
 */
function originOfLabels(labels) {
	for (const l of labels)
		if (l.startsWith(ORIGIN_PREFIX) && isOrigin(l.slice(ORIGIN_PREFIX.length)))
			return l.slice(ORIGIN_PREFIX.length);
	return null;
}

/** @type {{name: string, color: string, description: string}[]} */
const ORIGIN_LABELS = ORIGINS.map((o) => ({
	name: originLabel(o),
	color: "EDEDED",
	description: `Filed by the ${o} flow — file-issue.js --origin ${o}.`,
}));

module.exports = {
	ORIGINS,
	ORIGIN_LABELS,
	isOrigin,
	isScriptOrigin,
	originLabel,
	originOfLabels,
};
