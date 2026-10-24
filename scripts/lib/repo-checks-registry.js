/*
 * repo-checks-registry.js — every state check and reporter the daily
 * repo-checks run launches, and the gate each passes first (#1548, spec #1510
 * §The list and its gates). Data only: adding a check is one entry.
 *
 * LISTED IN RUN ORDER: the tree checks first, then the reporters, then the
 * tracker checks, with clobbered bodies last.
 *
 * AN ENTRY:
 *   id      the job name in the merged result. The tracker checks keep the
 *           job names of the weekly workflow #1557 retired.
 *   script  under the core's scripts/, with its arguments.
 *   kind    `check` speaks lib/check.js's `--json` envelope; `reporter` files
 *           or refreshes its own issue and is judged by its exit code alone.
 *   since   passes `--since <days>`: the days since the start of the last
 *           reading in which this entry completed (OK, WARN or FAIL), rounded
 *           up, plus one day of overlap; 30 on a repo's first, so a gap
 *           between runs widens the next window (#1551). A finding on an
 *           issue the window has moved past stays standing only by `rescan`.
 *   rescan  passes `--rescan <n,n,…>`: the issue numbers (`#N`) in the keys of
 *           this entry's last completed reading, so a finding stays reported
 *           until it is fixed (#1600); nothing on a repo's first reading.
 *   ceilingScale  multiplies the runner's per-check ceiling for this entry.
 *   settled the finding tags, each a key's first field, that someone has
 *           already settled — waived, accepted or reviewed. The runner keeps
 *           those keys out of the standing issue and the notify line (#1700).
 *   gate    every limb must hold, or the entry is SKIP and never launched:
 *           `modules` the host config must list, an `input` path that must
 *           exist at the host root, `tracker` resolving, `config` naming a
 *           key the host config must carry, and `core`, the host being
 *           workflow-core itself. The core keeps every input, so there
 *           `input` never holds an entry back: a missing one is launched and
 *           reports its own BROKEN (#1510 story 18, #1722). An input-gated
 *           checker that SKIPs on a missing input goes silent in the core.
 */

/**
 * @typedef {{ modules?: string[], input?: string, tracker?: true,
 *   config?: string, core?: true }} Gate
 * @typedef {{ id: string, script: string, args?: string[],
 *   kind: "check" | "reporter", since?: true, rescan?: true,
 *   ceilingScale?: number, settled?: string[],
 *   gate: Gate }} RepoCheck
 */

const ROADMAP = { modules: ["roadmap"] };
const GOVERNANCE = { modules: ["governance"] };
const DOC_MAP = { input: "docs/doc-map.md" };
const TRACKER = /** @type {const} */ ({ tracker: true });

/** @type {readonly RepoCheck[]} */
const REPO_CHECKS = [
	{
		id: "digest-version",
		script: "check-digest-version.js",
		kind: "check",
		gate: ROADMAP,
	},
	{
		id: "digest-render",
		script: "check-digest-render.js",
		kind: "check",
		gate: ROADMAP,
	},
	{
		id: "roadmap-valid",
		script: "check-roadmap-valid.js",
		args: ["--tree"],
		kind: "check",
		gate: ROADMAP,
	},
	{ id: "doc-map", script: "check-doc-map.js", kind: "check", gate: DOC_MAP },
	{
		id: "doc-map-markers",
		script: "check-doc-map-markers.js",
		kind: "check",
		gate: DOC_MAP,
	},
	{
		id: "superseded",
		script: "check-superseded-values.js",
		kind: "check",
		gate: GOVERNANCE,
	},
	{
		id: "restatements",
		script: "check-restatement-edges.js",
		kind: "check",
		gate: GOVERNANCE,
	},
	{
		id: "vocab",
		script: "check-retired-vocabulary.js",
		kind: "check",
		gate: GOVERNANCE,
	},
	{
		id: "machinery",
		script: "check-machinery-superseded.js",
		kind: "check",
		gate: { input: "docs/machinery-superseded.json" },
	},
	{
		id: "instruction-surface",
		script: "check-instruction-surface.js",
		kind: "check",
		gate: { input: "scripts/instruction-surface-anchors.json" },
	},
	{
		id: "suite-size",
		script: "check-suite-size-drift.js",
		kind: "check",
		gate: { modules: ["suites"] },
	},
	{
		id: "workflow-permissions",
		script: "check-workflow-permissions.js",
		kind: "check",
		gate: { input: ".github/workflows" },
	},
	{
		id: "manual-staleness",
		script: "report-manual-staleness.js",
		kind: "reporter",
		gate: { modules: ["governance", "roadmap"] },
	},
	{
		id: "doc-map-budget",
		script: "report-doc-map-budget.js",
		kind: "reporter",
		gate: GOVERNANCE,
	},
	{
		id: "cycle-review",
		script: "report-cycle-review-due.js",
		kind: "reporter",
		gate: GOVERNANCE,
	},
	{
		id: "retro",
		script: "report-retro-due.js",
		kind: "reporter",
		gate: { config: "retro" },
	},
	{
		id: "roadmap-ceilings",
		script: "report-roadmap-ceilings.js",
		kind: "reporter",
		gate: ROADMAP,
	},
	/* Core-only: one reading covers every corpus repo (#1625). */
	{
		id: "remeasure",
		script: "report-remeasure-due.js",
		kind: "reporter",
		gate: { core: true },
	},
	/* Core-only, and here rather than in the sweep: the sweep runs on the
	 * public code repo, whose token cannot reach the private tracker (#1963). */
	{
		id: "red-suite",
		script: "report-red-suite.js",
		kind: "reporter",
		gate: { core: true },
	},
	{
		id: "drift",
		script: "check-issue-card-drift.js",
		kind: "check",
		gate: { ...TRACKER, ...ROADMAP },
	},
	{
		id: "criteria",
		script: "check-ticket-criteria.js",
		kind: "check",
		settled: ["WAIVED", "NO-CRITERIA"],
		gate: TRACKER,
	},
	{
		id: "citations",
		script: "check-issue-citations.js",
		kind: "check",
		gate: TRACKER,
	},
	{
		id: "orphans",
		script: "check-issue-orphans.js",
		kind: "check",
		gate: TRACKER,
	},
	{
		id: "labels",
		script: "check-issue-labels.js",
		kind: "check",
		gate: TRACKER,
	},
	{
		id: "claims",
		script: "check-stale-claims.js",
		kind: "check",
		gate: TRACKER,
	},
	{
		id: "open-maps",
		script: "check-open-maps.js",
		kind: "check",
		gate: TRACKER,
	},
	{
		id: "cycles",
		script: "check-issue-cycles.js",
		kind: "check",
		gate: TRACKER,
	},
	/* Moved from the sweep for the reason red-suite was (#1963). Its own
	 * gate SKIPs outside the core. */
	{
		id: "citation-ceiling",
		script: "check-citation-ceiling.js",
		kind: "check",
		gate: TRACKER,
	},
	/* `since`, not `--all`, which took 425 s on mantahostels (#1628). A gap
	 * widens the window towards that, hence twice the usual ceiling. */
	{
		id: "clobbers",
		script: "check-clobbered-bodies.js",
		kind: "check",
		since: true,
		rescan: true,
		ceilingScale: 2,
		settled: ["SUSPECT-REVIEWED"],
		gate: TRACKER,
	},
];

module.exports = { REPO_CHECKS };
