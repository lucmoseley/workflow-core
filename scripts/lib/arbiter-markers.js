const path = require("node:path");
const core = require("./arbiter-core.js");
const hookRecord = require("./hook-record.js");
const {
	MARKERS_REL,
	markersDir,
	PASS_MARKER_PREFIXES,
	SELF_PLUGIN_PREFIX,
} = require("./marker-root.js");
const {
	PREFIXES: pricedOptionsPrefixes,
} = require("./priced-options-limbs.js");
const { readSessionsResumeExpected } = require("./resume-expected.js");
const { readLinkedWorktrees } = require("./worktree-paths.js");

const MARKER_PREFIXES = [
	".concision-base-",
	".concision-nagged-",
	".codereview-nagged-",
	...PASS_MARKER_PREFIXES,
	...pricedOptionsPrefixes,
	".selection-sum-nagged-",
	".selection-sum-shape-nagged-",
	".uncommitted-nagged-",
	".held-clean-nagged-",
	".session-ceiling-nagged-windup-",
	".session-ceiling-nagged-hard-",
	".session-ceiling-nagged-turns-",
	".session-ceiling-compactions-",
	".scratch-written-",
	".compaction-trigger-",
	SELF_PLUGIN_PREFIX,
	".lost-deny-nagged-",
	".lost-deny-seen-",
	".automode-refusal-nagged-",
	".automode-refusal-seen-",
	".typecheck-owed-nagged-",
	".typecheck-red-",
	".unpushed-nagged-",
	".unpushed-seen-",
	".exhausted-map-nagged-",
	".held-ticket-nagged-",
	".paste-self-match-nagged-",
	".session-id-prose-nagged-",
	".parked-blocked-",
	".jev-advisory-nagged-",
	".jev-advisory-outage-",
	".jev-advisory-malformed-",
	".jev-advisory-refused-",
	".inventory-nagged-",
	".inventory-draft-nagged-",
	".needs-input-checklist-",
	".unasked-rerun-refused-",
];

const BREADCRUMB_PREFIX = ".hook-ran-";

const RULE_LATCH_PREFIX = ".rule-injected-";

// guess, workflow-core#5529
const MARKER_AGE_MS = 24 * 60 * 60 * 1000;

// 22 calls a guard over 5 quiet days measured, lucmoseley/mantahostels#3381
const BREADCRUMB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {string} f
 * @param {Iterable<string>} live
 */
function liveBreadcrumb(f, live) {
	for (const id of live) if (f.endsWith(`-${id}`)) return true;
	return false;
}

/**
 * @param {string} root
 * @returns {(id: string) => boolean}
 */
function buildResumeExpected(root) {
	try {
		const expected = readSessionsResumeExpected(root);
		return (id) => expected.has(id);
	} catch (e) {
		core.logError("pruneMarkers", e);
		return () => true;
	}
}

function pruneMarkers() {
	const live = core.readLiveOrLog("pruneMarkers");
	if (live === null) return;
	const root = core.repoRoot();
	const isResumeExpected = buildResumeExpected(root);
	const markers = markersDir(root);
	/** @param {string} f */
	const sparedMarker = (f) => {
		const prefix = MARKER_PREFIXES.find((p) => f.startsWith(p));
		if (!prefix) return true;
		const id = f.slice(prefix.length);
		return (
			live.has(id) ||
			(PASS_MARKER_PREFIXES.includes(prefix) && isResumeExpected(id))
		);
	};
	core.sweepAged(markers, MARKER_AGE_MS, sparedMarker);
	core.sweepAged(hookRecord.recordsDir(root), BREADCRUMB_AGE_MS, (f) =>
		f.startsWith(BREADCRUMB_PREFIX) ? liveBreadcrumb(f, live) : true,
	);
	core.sweepAged(markers, MARKER_AGE_MS, (f) =>
		f.startsWith(RULE_LATCH_PREFIX) ? liveBreadcrumb(f, live) : true,
	);
	const worktrees = readLinkedWorktrees(root);
	if (worktrees === null)
		core.logError("pruneMarkers", new Error("git worktree list failed"));
	for (const wt of worktrees ?? [])
		core.sweepAged(
			path.join(wt, MARKERS_REL),
			MARKER_AGE_MS,
			(f) => !f.startsWith(SELF_PLUGIN_PREFIX) || sparedMarker(f),
		);
}

module.exports = {
	pruneMarkers,
};
