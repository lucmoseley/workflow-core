#!/usr/bin/env node

const { runCheck } = require("./lib/check.js");
const { readRuleTextOr } = require("./lib/rule-text");
const { spawnGitSync } = require("./lib/git.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

const RESEARCH_DIR = "docs/research/";

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

const SPEC = {
	name: "research-added",
	usage: "node check-research-added.js [--json] [--warn]",
	run,
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
