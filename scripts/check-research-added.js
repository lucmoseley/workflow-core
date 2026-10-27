#!/usr/bin/env node
/*
 * check-research-added.js — refuses a commit that adds a file under
 * `docs/research/`, and prints the rule: research is posted on its issue,
 * never landed in the tree (#2356).
 *
 * Usage:
 *   node check-research-added.js [--json] [--warn]
 *
 * The rule's authored home is docs/agents/issue-tracker.md §Research
 * artefacts; this prints its generated fragment, `rule:research-in-tree`.
 *
 * ADDED, under --no-renames, so a rename or copy into the directory reads as
 * an add. Editing or deleting a note still there passes.
 *
 * IMPLICIT:  on a commit staging a path under docs/research/, refuses one that adds a file there.
 * JUSTIFIED: fail-safe — an index git will not read is BROKEN rather than green.
 * DEFEAT:    --warn caps the finding below the gating line, and pre-commit never passes it.
 */

const { runCheck } = require("./lib/check.js");
const { readRuleTextOr } = require("./lib/rule-text");
const { spawnGitSync } = require("./lib/git.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

const RESEARCH_DIR = "docs/research/";

/*
 * An unreadable fragment is check-guard-registry.js's assertion, not a reason
 * to call the verdict BROKEN (mantahostels#1649's split).
 */
function readResearchRule() {
	return readRuleTextOr(
		"research-in-tree",
		"Research never lands in docs/research/: post it on its issue",
		"check-research-added",
	).split("\n");
}

/** @param {Ctx} ctx */
function run(ctx) {
	const r = spawnGitSync(
		[
			"diff",
			"--cached",
			"--no-renames",
			"--diff-filter=A",
			"--name-only",
			"-z",
			"--",
			RESEARCH_DIR,
		],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) {
		ctx.broken(`cannot read the git index — ${r.stderr.trim()}`);
	}
	const added = r.stdout.split("\0").filter(Boolean);
	if (added.length === 0) {
		return { okLine: `the commit adds no file under ${RESEARCH_DIR}` };
	}
	ctx.fail("RESEARCH-ADDED", `adds ${added.join(", ")} under ${RESEARCH_DIR}`);
	ctx.say(`This commit adds ${added.length} file(s) under ${RESEARCH_DIR}:`);
	for (const file of added) ctx.say(`  ${file}`);
	ctx.say("");
	ctx.say("docs/agents/issue-tracker.md §Research artefacts:");
	for (const line of readResearchRule()) ctx.say(line);
	return { noun: "added research file(s)", count: added.length };
}

if (require.main === module) {
	runCheck({
		name: "research-added",
		usage: "node check-research-added.js [--json] [--warn]",
		run,
	});
}
