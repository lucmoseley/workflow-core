/*
 * shared-fault-notices.js — the post-commit fault notice's table: for each
 * lib/fault-profiles.js profile, the checker report-new-shared-faults.js runs
 * over the archived `--root` trees, the flag .husky/pre-commit gates it with,
 * and what a red there costs the OTHER sessions (mantahostels#1750, #4254).
 *
 * KEYED BY PROFILE NAME, ONE ROW PER PROFILE: report-new-shared-faults.test.ts
 * holds the keys equal to PROFILES and each `gate` equal to the hook's flag.
 * doc-map's checker takes no archived `--root` tree; the program runs its
 * row's script through readDocMapEnvelope instead.
 *
 * `full` is the command that shows the reader MORE than the notice already
 * did — the checker itself, over the working tree, WARNs and context included.
 */

const path = require("node:path");
const { scriptPath } = require("./script-path.js");

/** @typedef {"against" | "index"} Gate */

/** The `why` clause each gate kind earns. doc-map's own staged-vs-HEAD block
 * in the hook is an `against` gate in all but its flag. */
const GATE_CLAUSE = {
	against: "direction-gated in .husky/pre-commit",
	index: "judged on the index in .husky/pre-commit",
};

/** @type {Record<string, { script: string, gate: Gate, scope: string, cite?: string, cost: string }>} */
const ROWS = {
	"guard-registry": {
		script: "check-guard-registry.js",
		gate: "against",
		scope: "whole-repo",
		cite: "(mantahostels#1801)",
		cost:
			"fails the scheduled sweeps, and warns every other session's commit " +
			"touching docs/, .claude/, scripts/, .husky/, self-plugin/, CLAUDE.md " +
			"or AGENTS.md, refusing only one that adds a fault of its own",
	},
	"guard-test-isolation": {
		script: "check-guard-test-isolation.js",
		gate: "against",
		scope: "whole-repo",
		cite: "(mantahostels#1753)",
		cost:
			"fails the scheduled sweeps, and warns every other session's commit " +
			"touching a scripts/ test, .ts or shell file, refusing only one that " +
			"adds a fault of its own",
	},
	"host-root-test-isolation": {
		script: "check-host-root-test-isolation.js",
		gate: "against",
		scope: "whole-repo",
		cite: "(mantahostels#1753)",
		cost:
			"warns every other session's commit touching a scripts/ test or " +
			"script, refusing only one that adds a fault of its own",
	},
	"git-fixture-identity": {
		script: "check-git-fixture-identity.js",
		gate: "against",
		scope: "whole-repo",
		cite: "(mantahostels#1753)",
		cost:
			"fails the scheduled sweeps, and warns every other session's commit " +
			"touching a scripts/ test file, refusing only one that adds a " +
			"raw-init/raw-commit pair of its own",
	},
	"doc-map": {
		script: "check-doc-map.js",
		gate: "against",
		scope: "whole-repo assertion",
		cost: "fails the scheduled sweeps, and warns every other session's docs commit",
	},
	"context-budget": {
		script: "check-context-budget.js",
		gate: "against",
		scope: "whole-repo surface",
		cite: "(mantahostels#1834)",
		cost:
			"warns every other session's commit touching docs/, .claude/, CLAUDE.md, " +
			"AGENTS.md or the tracker injector, and refuses the next one that adds " +
			"to the same surface",
	},
	"website-copy": {
		script: "check-website-copy.js",
		gate: "against",
		scope: "whole-repo scan of app/",
		cite: "(mantahostels#1834)",
		cost: "warns every other session's commit touching app/",
	},
	"skill-frontmatter": {
		script: "check-skill-frontmatter.js",
		gate: "against",
		scope: "every own skill",
		cite: "(#887)",
		cost: "fails the scheduled sweep, and warns every other session's commit touching that skill",
	},
	"host-root": {
		script: "check-host-root.js",
		gate: "against",
		scope: "every script's host-root seam",
		cite: "(#917)",
		cost: "warns every other session's commit touching scripts/, .claude/ or .husky/",
	},
	"jsonl-reads": {
		script: "check-jsonl-reads.js",
		gate: "index",
		scope: "every hand split-and-parse of JSONL",
		cite: "(#3452, #3453)",
		cost: "refuses every other session's commit staging a scripts/ program until that site reads through lib/jsonl.js",
	},
	"gh-route": {
		script: "check-gh-route.js",
		gate: "index",
		scope: "every `gh` call off lib/gh.js and WFC_GH",
		cite: "(#3455)",
		cost: "refuses every other session's commit staging scripts/, .claude/skills/, .husky/ or hooks/ until that call reads WFC_GH",
	},
	"arbiter-commands": {
		script: "check-arbiter-commands.js",
		gate: "index",
		scope:
			"every arbiter command spelt by hand rather than through buildArbiterCommand",
		cite: "(#3990)",
		cost: "refuses every other session's commit staging a scripts/ program until that command goes through the tag",
	},
	"clock-copies": {
		script: "check-clock-copies.js",
		gate: "index",
		scope: "every WFC_NOW read outside lib/check.js's now()",
		cite: "(#3457)",
		cost: "refuses every other session's commit staging a scripts/ program until that read goes through now()",
	},
	"report-programs": {
		script: "check-report-programs.js",
		gate: "index",
		scope: "every report-* program's issue filing",
		cite: "(#3454)",
		cost: "refuses every other session's commit staging a report-* until that program files through createIssue",
	},
	"program-output": {
		script: "check-program-output.js",
		gate: "index",
		scope: "every write past writeFd in a program ending in process.exit",
		cite: "(#4018)",
		cost: "refuses every other session's commit staging a scripts/ or skill program until that write goes through writeFd",
	},
	"precommit-exit": {
		script: "check-precommit-exit.js",
		gate: "index",
		scope:
			"every checker line in .husky/pre-commit and .husky/pre-commit.local",
		cite: "(#3456)",
		cost: "refuses every other session's commit staging either hook until that line passes its checker's exit code on",
	},
	"cli-args": {
		script: "check-cli-args.js",
		gate: "against",
		scope: "every top-level script's argv reader",
		cite: "(#920)",
		cost: "refuses every other session's commit that edits that script until it parses its argv strictly",
	},
	"test-spawn": {
		script: "check-test-spawn.js",
		gate: "index",
		scope: "every test's spawn of node on the program under test",
		cite: "(#3458)",
		cost: "refuses every other session's commit staging a test until that spawn runs in-process or states why",
	},
	registrations: {
		script: "check-registrations.js",
		gate: "against",
		scope: "a host's own hooks, guards and checkers",
		cite: "(#1456)",
		cost: "refuses every other session's commit touching .claude/settings.json, a host registry, scripts/, .husky/ or a workflow",
	},
};

/* Every checker ships in scripts/, beside this lib's directory (#1). */
const CORE_SCRIPTS = path.join(__dirname, "..");

/** @type {Record<string, { script: string, gate: Gate, why: string, cost: string, full: string }>} */
const NOTICES = Object.fromEntries(
	Object.entries(ROWS).map(([profile, { script, gate, scope, cite, cost }]) => [
		profile,
		{
			script: path.join(CORE_SCRIPTS, script),
			gate,
			why: `${scope}, ${GATE_CLAUSE[gate]}${cite ? ` ${cite}` : ""}`,
			cost,
			full: `node ${scriptPath(script)}`,
		},
	]),
);

module.exports = { NOTICES };
