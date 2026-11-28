/**
 * @typedef {{ modules?: string[], input?: string, tracked?: string,
 *   tracker?: true, config?: string, core?: true }} Gate
 * @typedef {{ id: string, script: string, args?: string[],
 *   kind: "check" | "reporter", since?: true, rescan?: true,
 *   ceilingScale?: number, settled?: string[],
 *   gate: Gate }} RepoCheck
 * @typedef {{ root: string, file: string, core: boolean, modules: Set<string>,
 *   config: Record<string, unknown>, tracker: () => string | null,
 *   tracked: (rel: string) => boolean }} Host
 */

const fs = require("node:fs");
const path = require("node:path");
const { CI_WORKFLOW } = require("./adopter-ci.js");
const { gitOrNull } = require("./git.js");
const { isCoreHost } = require("./plugin-state.js");
const { readConfig, resolveKey } = require("./workflow-core-config.js");

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
		gate: { core: true },
	},
	{
		id: "workflow-permissions",
		script: "check-workflow-permissions.js",
		kind: "check",
		gate: { input: ".github/workflows" },
	},
	{
		id: "chrome-tab-leftovers",
		script: "check-chrome-tab-leftovers.js",
		kind: "check",
		since: true,
		gate: { core: true },
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
	{
		id: "remeasure",
		script: "report-remeasure-due.js",
		kind: "reporter",
		gate: { core: true },
	},
	{
		id: "release-due",
		script: "report-release-due.js",
		kind: "reporter",
		gate: { core: true },
	},
	{
		id: "stale-run-stamp",
		script: "report-stale-run-stamp.js",
		kind: "reporter",
		gate: { core: true },
	},
	{
		id: "red-suite",
		script: "report-red-suite.js",
		kind: "reporter",
		gate: { tracked: CI_WORKFLOW },
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
		ceilingScale: 2,
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
	{
		id: "citation-ceiling",
		script: "check-citation-ceiling.js",
		kind: "check",
		gate: TRACKER,
	},
	{
		id: "clobbers",
		script: "check-clobbered-bodies.js",
		kind: "check",
		since: true,
		rescan: true,
		ceilingScale: 2,
		settled: ["SUSPECT-REVIEWED", "CLOBBERED-REVIEWED"],
		gate: TRACKER,
	},
];

/**
 * @param {string} id
 * @returns {RepoCheck}
 */
function entryOf(id) {
	const entry = REPO_CHECKS.find((e) => e.id === id);
	if (!entry) throw new Error(`no registry entry "${id}"`);
	return entry;
}

/**
 * @param {string} root
 * @param {(root: string) => unknown} [resolveTracker]
 * @returns {Host}
 */
function readHost(
	root,
	resolveTracker = (r) => resolveKey("tracker", { root: r }),
) {
	const c = readConfig({ root, quiet: true });
	/** @type {string | null | undefined} */
	let tracker;
	return {
		root,
		file: path.relative(root, c.file),
		core: isCoreHost(root),
		modules: new Set(c.modules),
		config: /** @type {Record<string, unknown>} */ (c),
		tracker: () => {
			if (tracker === undefined) {
				const t = resolveTracker(root);
				tracker = typeof t === "string" ? t : null;
			}
			return tracker;
		},
		tracked: (rel) =>
			Boolean(gitOrNull(["ls-files", "--", rel], { cwd: root })?.trim()),
	};
}

/**
 * @param {RepoCheck} entry
 * @param {Host} host
 * @returns {string | null}
 */
function gateFault({ gate }, host) {
	for (const m of gate.modules ?? [])
		if (!host.modules.has(m)) return `module "${m}" is off in ${host.file}`;
	if (
		gate.input &&
		!host.core &&
		!fs.existsSync(path.join(host.root, gate.input))
	)
		return `this repo keeps no ${gate.input}`;
	if (gate.tracked && !host.core && !host.tracked(gate.tracked))
		return `this repo tracks no ${gate.tracked}`;
	if (gate.config && host.config[gate.config] === undefined)
		return `${host.file} carries no "${gate.config}" key`;
	if (gate.tracker && !host.tracker())
		return `no tracker resolves from ${host.file} or the origin remote`;
	if (gate.core && !host.core) return "this repo is not workflow-core itself";
	return null;
}

module.exports = { REPO_CHECKS, entryOf, gateFault, readHost };
