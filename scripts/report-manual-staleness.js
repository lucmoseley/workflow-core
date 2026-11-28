#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { parseOrExit } = require("./lib/cli-args");
const { fileOrRefresh } = require("./lib/tracking-issue");
const { exitUnlessModule, MANUAL_HALF } = require("./lib/workflow-core-config");
const { caught } = require("./lib/caught.js");
const { takesLabel } = require("./lib/takes-label");

const TITLE = "Operating manual is stale against the roadmap";
const LABEL = "manual-finding";
const TAKES = takesLabel("triage");

const freshnessModule = () =>
	process.env.WFC_MANUAL_FRESHNESS_MODULE || "./check-manual-freshness";

function freshness() {
	const { CheckContext } = require("./lib/check");
	const { SPEC } = require(freshnessModule());
	/** @type {string[]} */
	const lines = [];
	const ctx = new CheckContext([], {
		usage: SPEC.usage,
		valueFlags: SPEC.valueFlags,
		capture: lines,
	});
	let result;
	try {
		result = SPEC.run(ctx) || {};
	} catch (e) {
		throw new Error(
			`check-manual-freshness.js could not run: ${caught(e).message}`,
			{
				cause: e,
			},
		);
	}
	const gating = ctx.findings.filter((f) => f.severity === "FAIL");
	const warned = ctx.findings.filter((f) => f.severity === "WARN");
	let outcome = "OK";
	if (gating.length > 0) outcome = "FAIL";
	else if (warned.length > 0) outcome = "WARN";
	const count = gating.length > 0 || warned.length > 0;
	const noun = result.noun || "finding(s)";
	lines.push(
		outcome === "OK"
			? `OK: ${result.okLine || "nothing found."}`
			: `${outcome}: ${count} ${noun}`,
	);
	return { stale: outcome === "FAIL", report: lines.join("\n").trim() };
}

/** @param {string} report */
function body(report) {
	return [
		"Filed automatically by `scripts/report-manual-staleness.js`, from the",
		"daily repo-checks run at session start, which rewrites this body each day the manual is still behind.",
		"**Edit it by hand and the next daily refresh silently overwrites it** —",
		"`issue-body.js replace` only refuses a write landing during the call itself,",
		"not a hand edit sitting between refreshes — so put anything you want kept in a",
		"comment.",
		"",
		"```",
		report || "(the checker produced no output)",
		"```",
		"",
		"## What to do",
		"",
		"Run the `manual-sync` skill. A full sync re-synthesises `docs/operating-manual.md`",
		"and advances its provenance anchors, which is what clears this.",
		"",
		"## Why this is an issue and not a red build",
		"",
		"Manual staleness is standing repo state, not a property of any commit, so gating",
		"`push`/`pull_request` on it reddened commits that neither caused it nor could fix",
		"it — 16 consecutive red runs on `main` over roughly 24 hours on 14 August 2026,",
		"from this one condition. Ruled at mantahostels#389.",
		"",
		"This issue stays open until a sync lands. While it is open the daily repo-checks",
		"run at session start refreshes this body and files nothing new, so there is one",
		"issue however long the debt runs.",
	].join("\n");
}

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-manual-staleness.js")}`,
	});
	exitUnlessModule(MANUAL_HALF);
	const { MANUAL } = require("./check-manual-freshness");
	if (!fs.existsSync(MANUAL)) {
		writeFd(
			2,
			`SKIP: no operating manual at ${MANUAL} yet — nothing to be stale.\n`,
		);
		return;
	}
	const { stale, report } = freshness();

	if (!stale) {
		writeFd(1, "Operating manual is fresh — nothing to file.\n");
		writeFd(1, `${report.trim()}\n`);
		return;
	}

	writeFd(
		1,
		`Operating manual is stale. ${
			fileOrRefresh({
				title: TITLE,
				label: LABEL,
				labels: [LABEL, TAKES],
				body: body(report),
			}).text
		}\n`,
	);
}

if (require.main === module) main();

module.exports = { TITLE, LABEL, freshness };
