const { fromCoreRoot, PROFILE_GATES: GATES } = require("./precommit-gates.js");

/** @typedef {"against" | "index"} Gate */

const GATE_CLAUSE = {
	against: "direction-gated in .husky/pre-commit",
	index: "judged on the index in .husky/pre-commit",
};

/** @type {Record<string, { script: string, gate: Gate, scope: string, cite?: string, cost: string }>} */
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
		GATES.map((g) => [
			g.id,
			{
				script: g.script,
				/** @type {Gate} */
				gate: g.args[0] === "--index" ? "index" : "against",
				facts: g.when?.facts ?? [],
				...g.notice,
			},
		]),
	),
	...OWN_BLOCK_ROWS,
};

/** @type {Record<string, { script: string, gate: Gate, facts: string[], why: string, cost: string }>} */
const NOTICES = Object.fromEntries(
	Object.entries(ROWS).map(([profile, row]) => {
		const { script, gate, scope, cite, cost } = row;
		return [
			profile,
			{
				script: fromCoreRoot(script),
				gate,
				facts: "facts" in row ? row.facts : [],
				why: `${scope}, ${GATE_CLAUSE[gate]}${cite ? ` ${cite}` : ""}`,
				cost,
			},
		];
	}),
);

module.exports = { NOTICES };
