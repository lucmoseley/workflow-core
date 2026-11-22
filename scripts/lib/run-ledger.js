const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { gitRead } = require("./dirty-tree.js");
const { ignoreFailure } = require("./caught.js");

const RUN_LEDGER = ".test-runs.jsonl";
// guess, #2824
const RETAIN_MS = 30 * DAY_MS;

/** @typedef {import("./test-pass-marker.js").Marker} Marker */

/**
 * @param {Marker} m
 * @param {boolean} fullFlag
 */
function ranFull({ scope }, fullFlag) {
	const total = scope?.modulesTotal ?? 0;
	return Boolean(
		scope?.full ||
			fullFlag ||
			(total > 0 && (scope?.modulesRun ?? 0) >= 0.9 * total),
	);
}

/** @param {string[]|null|undefined} argv */
const hasFullFlag = (argv) =>
	argv?.some((a) => a.startsWith("--full")) ?? false;

/**
 * @param {{ argv: string[]|null|undefined, touched: boolean, full: boolean,
 *   lander: boolean, suite?: string, viaChanged?: boolean,
 *   fileFilters?: boolean }} launch
 * @returns {string}
 */
function kindOfLaunch({
	argv,
	touched,
	full,
	lander,
	suite = "vitest",
	viaChanged = false,
	fileFilters = false,
}) {
	if (touched) return "touched";
	if (suite === "pytest") return "pytest";
	const fullFlag = hasFullFlag(argv);
	if (lander && fullFlag) return "lander";
	if (full || fullFlag) return "full";
	if (argv?.includes("--adopt")) return "adopt";
	if (argv?.includes("--changed") || viaChanged) return "changed";
	if (!argv) return fileFilters ? "named" : "bare";
	const named =
		argv.includes("--retest") ||
		argv.includes("-t") ||
		argv.some((a) => !a.startsWith("-"));
	return named ? "named" : "bare";
}

/**
 * @param {Marker} m
 * @returns {string}
 */
const kindOf = (m) =>
	kindOfLaunch({
		argv: m.argv,
		touched: Boolean(m.scope?.touched),
		full: ranFull(m, hasFullFlag(m.argv)),
		lander: Boolean(m.lander),
		suite: m.suite,
		viaChanged: Boolean(m.scope?.viaChanged),
		fileFilters: Boolean(m.scope?.fileFilters?.length),
	});

/**
 * @param {Marker} m
 * @returns {string|null}
 */
function fullCauseOf({ argv, scope }) {
	const flag = argv?.find((a) => a.startsWith("--full="));
	if (flag) return flag.slice("--full=".length);
	if (scope?.fullCause) return scope.fullCause;
	if (scope?.full && scope.full !== "flag") return `escalation:${scope.full}`;
	return argv?.includes("--full") ? "bare --full" : null;
}

/** @param {Marker} m @param {boolean} green */
function verdictOf(m, green) {
	if (m.ceilingKill) return "killed";
	if (m.stalled) return "stalled";
	return green ? "green" : "red";
}

/** @param {Marker["scope"]} scope */
const scopeFields = (scope) => ({
	resolvedFiles: scope?.resolvedFiles ?? null,
	leftOut: scope?.leftOut ?? null,
	touchedBase: scope?.touchedBase ?? null,
	wholeSlot: scope?.wholeSlot === true,
	ranFiles: scope?.modulesRun ?? null,
});

/**
 * @param {Marker} m
 * @param {{ green: boolean, root: string }} where
 */
function buildLedgerLine(m, { green, root }) {
	const kind = kindOf(m);
	const fullCause =
		kind === "full" || kind === "lander" ? fullCauseOf(m) : null;
	return {
		startedAt: m.startedAt ?? null,
		at: m.at ?? new Date().toISOString(),
		durationMs: m.durationMs ?? null,
		kind,
		...(fullCause ? { fullCause } : {}),
		verdict: verdictOf(m, green),
		suite: m.suite ?? "vitest",
		session: m.sessionId ?? null,
		lander: m.lander === true,
		sha: m.sha,
		treeAtEnd: m.treeAtEnd ?? null,
		argv: m.argv ?? null,
		...scopeFields(m.scope),
		cachedFiles: Array.isArray(m.cached) ? m.cached.length : null,
		memory: m.memory ?? null,
		...(m.admission ? { admission: m.admission } : {}),
		repo: path.basename(root),
	};
}

/** @param {string} root @param {Marker} marker @param {boolean} green */
function appendLedgerLine(root, marker, green) {
	if (marker.refused) return;
	ignoreFailure(() =>
		appendRetained(
			path.join(markersDir(root), RUN_LEDGER),
			buildLedgerLine(marker, { green, root }),
			RETAIN_MS,
		),
	);
}

/**
 * @param {string} root
 * @param {string} tree
 * @param {{ suite: string, sessionId?: string|null, argv: string[],
 *   leftOut: string[],
 *   touchedBase: import("./test-pass-marker.js").TouchedBase }} run
 */
function appendEmptyTouchedLine(
	root,
	tree,
	{ suite, sessionId, argv, leftOut, touchedBase },
) {
	const at = new Date().toISOString();
	appendLedgerLine(
		root,
		{
			sha: gitRead(["rev-parse", "HEAD"], tree)?.trim() || "unknown",
			at,
			startedAt: at,
			durationMs: 0,
			suite,
			scope: {
				modulesRun: 0,
				modulesTotal: 0,
				tests: 0,
				skipped: 0,
				touched: true,
				resolvedFiles: 0,
				leftOut,
				touchedBase,
			},
			sessionId,
			argv,
		},
		true,
	);
}

module.exports = {
	RUN_LEDGER,
	appendEmptyTouchedLine,
	appendLedgerLine,
	kindOfLaunch,
};
