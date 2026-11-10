/*
 * issue-origin.js — the fixed list of filing flows file-issue.js requires as
 * `--origin`, and the `origin:<class>` label each stamps, so the weekly
 * ticket-mix review counts origins without a model (#4796, #4629).
 *
 * A new flow takes a new entry here; the
 * labels reach each adopter through lib/adopter-skeleton.js's label plan.
 */

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
	"founder",
]);

/**
 * The origins a script files under, declaring `--no-fault` in code: the
 * outcome review's miss backstop passes them over, and holds every other
 * origin's undeclared fault-shaped ticket to account. Nothing stops a session
 * passing one of these `--origin` by hand, and its ticket then skips the
 * backstop too.
 */
const SCRIPT_ORIGINS = /** @type {readonly string[]} */ ([
	"lander-script",
	"orphaned-edit-script",
	"ci-red",
	"incident",
	"morning-review-script",
]);

const ORIGIN_PREFIX = "origin:";

/** @param {string} origin */
const originLabel = (origin) => `${ORIGIN_PREFIX}${origin}`;

/** @param {string} v @returns {boolean} */
const isOrigin = (v) => /** @type {readonly string[]} */ (ORIGINS).includes(v);

/** @param {string | null} origin */
const isScriptOrigin = (origin) =>
	origin !== null && SCRIPT_ORIGINS.includes(origin);

/**
 * The origin a label set carries, or null.
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
