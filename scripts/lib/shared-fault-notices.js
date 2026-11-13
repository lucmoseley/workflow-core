/*
 * shared-fault-notices.js — the post-commit fault notice's table: for each
 * lib/fault-profiles.js profile, the checker report-new-shared-faults.js runs
 * over the archived `--root` trees, the flag .husky/pre-commit gates it with,
 * and what a red there costs the OTHER sessions (mantahostels#1750, workflow-core#4254).
 *
 * KEYED BY PROFILE NAME, ONE ROW PER PROFILE: a whole-repo gate's row is its
 * lib/precommit-gates.js `notice`. report-new-shared-faults.test.ts holds the
 * keys equal to PROFILES and each `gate` equal to the hook's flag.
 * doc-map's checker takes no archived `--root` tree; the program runs its
 * row's script through readDocMapEnvelope instead.
 *
 * `full` is the command that shows the reader MORE than the notice already
 * did — the checker itself, over the working tree, WARNs and context included.
 */

const path = require("node:path");
const { scriptPath } = require("./script-path.js");
const { fromCoreRoot, GATES } = require("./precommit-gates.js");

/** @typedef {"against" | "index"} Gate */

/** The `why` clause each gate kind earns. doc-map's own staged-vs-HEAD block
 * in the hook is an `against` gate in all but its flag. */
const GATE_CLAUSE = {
	against: "direction-gated in .husky/pre-commit",
	index: "judged on the index in .husky/pre-commit",
};

/**
 * The two direction-gated checkers whose hook block is not a whole-repo gate
 * row: doc-map's staged-vs-HEAD block and context-budget's.
 * @type {Record<string, { script: string, gate: Gate, scope: string, cite?: string, cost: string }>}
 */
const OWN_BLOCK_ROWS = {
	"doc-map": {
		script: "scripts/check-doc-map.js",
		gate: "against",
		scope: "whole-repo assertion",
		cost: "fails the scheduled sweeps, and warns every other session's docs commit",
	},
	"context-budget": {
		script: "scripts/check-context-budget.js",
		gate: "against",
		scope: "whole-repo surface",
		cite: "(mantahostels#1834)",
		cost:
			"warns every other session's commit touching docs/, .claude/, CLAUDE.md, " +
			"AGENTS.md or the tracker injector, and refuses the next one that adds " +
			"to the same surface",
	},
};

const ROWS = {
	...Object.fromEntries(
		GATES.map((g) => [g.id, { script: g.script, gate: g.flag, ...g.notice }]),
	),
	...OWN_BLOCK_ROWS,
};

/** @type {Record<string, { script: string, gate: Gate, why: string, cost: string, full: string }>} */
const NOTICES = Object.fromEntries(
	Object.entries(ROWS).map(([profile, { script, gate, scope, cite, cost }]) => [
		profile,
		{
			script: fromCoreRoot(script),
			gate,
			why: `${scope}, ${GATE_CLAUSE[gate]}${cite ? ` ${cite}` : ""}`,
			cost,
			full: `node ${scriptPath(path.basename(script))}`,
		},
	]),
);

module.exports = { NOTICES };
