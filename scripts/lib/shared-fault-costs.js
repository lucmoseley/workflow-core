/*
 * shared-fault-costs.js — why each registered checker is in the notice, and what a red there costs the
 * OTHER sessions (mantahostels#1750).
 *
 * `full` is the command that shows the reader MORE than the notice already
 * did — the checker itself, over the working tree, WARNs and context included.
 *
 * KEYED BY PROFILE NAME, AND EVERY lib/fault-profiles.js PROFILE HAS A ROW —
 * a profile with none throws, and report-new-shared-faults.test.ts prints a
 * cost line for every profile, so registering a checker for the diff and
 * registering it for the notice are one act. A row no profile names is
 * harmless and goes unchecked.
 */

const { scriptPath } = require("./script-path.js");

/** @type {Record<string, { why: string, cost: string, full: string }>} */
const COSTS = {
	"guard-registry": {
		why: "whole-repo, direction-gated in .husky/pre-commit (mantahostels#1801)",
		cost:
			"fails the scheduled sweeps, and warns every other session's commit " +
			"touching docs/, .claude/, scripts/, .husky/, self-plugin/, CLAUDE.md " +
			"or AGENTS.md, refusing only one that adds a fault of its own",
		full: `node ${scriptPath("check-guard-registry.js")}`,
	},
	"guard-test-isolation": {
		why: "whole-repo, direction-gated in .husky/pre-commit (mantahostels#1753)",
		cost:
			"fails the scheduled sweeps, and warns every other session's commit " +
			"touching a scripts/ test, .ts or shell file, refusing only one that " +
			"adds a fault of its own",
		full: `node ${scriptPath("check-guard-test-isolation.js")}`,
	},
	"host-root-test-isolation": {
		why: "whole-repo, direction-gated in .husky/pre-commit (mantahostels#1753)",
		cost:
			"warns every other session's commit touching a scripts/ test or " +
			"script, refusing only one that adds a fault of its own",
		full: `node ${scriptPath("check-host-root-test-isolation.js")}`,
	},
	"git-fixture-identity": {
		why: "whole-repo, direction-gated in .husky/pre-commit (mantahostels#1753)",
		cost:
			"fails the scheduled sweeps, and warns every other session's commit " +
			"touching a scripts/ test file, refusing only one that adds a " +
			"raw-init/raw-commit pair of its own",
		full: `node ${scriptPath("check-git-fixture-identity.js")}`,
	},
	"doc-map": {
		why: "whole-repo assertion, direction-gated in .husky/pre-commit",
		cost: "fails the scheduled sweeps, and warns every other session's docs commit",
		full: `node ${scriptPath("check-doc-map.js")}`,
	},
	"context-budget": {
		why: "whole-repo surface, direction-gated in .husky/pre-commit (mantahostels#1834)",
		cost:
			"warns every other session's commit touching docs/, .claude/, CLAUDE.md, " +
			"AGENTS.md or the tracker injector, and refuses the next one that adds " +
			"to the same surface",
		full: `node ${scriptPath("check-context-budget.js")}`,
	},
	"website-copy": {
		why: "whole-repo scan of app/, direction-gated in .husky/pre-commit (mantahostels#1834)",
		cost: "warns every other session's commit touching app/",
		full: `node ${scriptPath("check-website-copy.js")}`,
	},
	"skill-frontmatter": {
		why: "every own skill, direction-gated in .husky/pre-commit (#887)",
		cost: "fails the scheduled sweep, and warns every other session's commit touching that skill",
		full: `node ${scriptPath("check-skill-frontmatter.js")}`,
	},
	"host-root": {
		why: "every script's host-root seam, direction-gated in .husky/pre-commit (#917)",
		cost: "warns every other session's commit touching scripts/, .claude/ or .husky/",
		full: `node ${scriptPath("check-host-root.js")}`,
	},
	"jsonl-reads": {
		why: "every hand split-and-parse of JSONL, judged whole-tree in .husky/pre-commit (#3452, #3453)",
		cost: "refuses every other session's commit staging a scripts/ program until that site reads through lib/jsonl.js",
		full: `node ${scriptPath("check-jsonl-reads.js")}`,
	},
	"gh-route": {
		why: "every `gh` call off lib/gh.js and WFC_GH, judged whole-tree in .husky/pre-commit (#3455)",
		cost: "refuses every other session's commit staging scripts/, .claude/skills/, .husky/ or hooks/ until that call reads WFC_GH",
		full: `node ${scriptPath("check-gh-route.js")}`,
	},
	"arbiter-commands": {
		why: "every arbiter command spelt by hand rather than through buildArbiterCommand, judged whole-tree in .husky/pre-commit (#3990)",
		cost: "refuses every other session's commit staging a scripts/ program until that command goes through the tag",
		full: `node ${scriptPath("check-arbiter-commands.js")}`,
	},
	"clock-copies": {
		why: "every WFC_NOW read outside lib/check.js's now(), judged whole-tree in .husky/pre-commit (#3457)",
		cost: "refuses every other session's commit staging a scripts/ program until that read goes through now()",
		full: `node ${scriptPath("check-clock-copies.js")}`,
	},
	"report-programs": {
		why: "every report-* program's output and issue filing, judged whole-tree in .husky/pre-commit (#3454)",
		cost: "refuses every other session's commit staging a report-* until that program writes through writeFd and files through createIssue",
		full: `node ${scriptPath("check-report-programs.js")}`,
	},
	"precommit-exit": {
		why: "every checker line in .husky/pre-commit and .husky/pre-commit.local, judged on the index in .husky/pre-commit (#3456)",
		cost: "refuses every other session's commit staging either hook until that line passes its checker's exit code on",
		full: `node ${scriptPath("check-precommit-exit.js")}`,
	},
	"cli-args": {
		why: "every top-level script's argv reader, direction-gated in .husky/pre-commit (#920)",
		cost: "refuses every other session's commit that edits that script until it parses its argv strictly",
		full: `node ${scriptPath("check-cli-args.js")}`,
	},
	"test-spawn": {
		why: "every test's spawn of node on the program under test, judged whole-tree in .husky/pre-commit (#3458)",
		cost: "refuses every other session's commit staging a test until that spawn runs in-process or states why",
		full: `node ${scriptPath("check-test-spawn.js")}`,
	},
	registrations: {
		why: "a host's own hooks, guards and checkers, direction-gated in .husky/pre-commit (#1456)",
		cost: "refuses every other session's commit touching .claude/settings.json, a host registry, scripts/, .husky/ or a workflow",
		full: `node ${scriptPath("check-registrations.js")}`,
	},
};

module.exports = { COSTS };
