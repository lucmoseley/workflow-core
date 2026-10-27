#!/usr/bin/env node
/*
 * report-manual-staleness.js — the issue-filing half of the scheduled
 * manual-freshness gate (mantahostels#389), run by the daily repo-checks run
 * (workflow-core#1557).
 *
 * `check-manual-freshness.js` tests STANDING REPO STATE, not the commit's diff:
 * the operating manual is either behind the roadmap or it is not, and no push
 * causes or cures that. So it runs daily, not per push, and its finding lands as ONE
 * tracked issue instead of N red runs. The measurement that decided it is in
 * mantahostels#389.
 *
 * One issue, kept current: it opens the tracking issue when none is open, and
 * otherwise rewrites that issue's body with the day's figures. A body edit
 * notifies nobody, so a debt taking days to clear never mails twice.
 *
 * Exit code is 0 whether or not the manual is stale — the issue is the signal.
 * It exits non-zero only when it cannot do its job (gh missing, API refusing)
 * or lib/cli-args.js refuses its command line.
 */

const fs = require("node:fs");
const { parseOrExit } = require("./lib/cli-args");
const { fileOrRefresh } = require("./lib/tracking-issue");
const { exitUnlessModule, MANUAL_HALF } = require("./lib/workflow-core-config");
const { caught } = require("./lib/caught.js");
const { takesLabel } = require("./lib/takes-label");

const TITLE = "Operating manual is stale against the roadmap";
const LABEL = "manual-finding";
const TAKES = takesLabel("triage");

/* Overridable so the suite can stand a stub in without touching the real
 * checker's module. */
const freshnessModule = () =>
	process.env.WFC_MANUAL_FRESHNESS_MODULE || "./check-manual-freshness";

/*
 * The freshness checker's own verdict and report text — read by calling its
 * SPEC.run() in THIS process rather than shelling out to a second `node`
 * — `check-cleared-trackers.js` requires this module inside a `SessionStart`
 * fan-out where that checker has already run as its own hook, so a spawn here
 * runs it twice (mantahostels#2062). Never restore one.
 *
 * `require("./lib/check")` is lazy, inside this function, not at module top:
 * it installs lib/check.js's process-wide crash reporter as a side effect of
 * loading, and this script's own standalone invocation (the daily
 * repo-checks run) must keep its own exit code on an unexpected throw
 * rather than being handed check.js's `BROKEN:` / exit-2 shape.
 *
 * NO `--json`: `capture` takes every line `say()` would otherwise write to its
 * fd, so the checker's own detail lines (stamp shape, roadmap distance, …)
 * land in `report`, not just the finding messages. Keep argv `[]` and
 * `ctx.notify` false. The summary line `finish()` would have appended is
 * pushed by hand below: `run()`'s one `ctx.skip()` is on a missing manual,
 * which main() skips before calling this, so every non-throwing return is OK,
 * WARN or FAIL. check-cleared-trackers.js calls it without that test, and
 * gets the skip as a throw — an unreadable condition, never a cleared one.
 */
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
		usage: "usage: node scripts/report-manual-staleness.js",
	});
	exitUnlessModule(MANUAL_HALF);
	// Lazy for the reason freshness() gives: the checker loads lib/check.
	const { MANUAL } = require("./check-manual-freshness");
	if (!fs.existsSync(MANUAL)) {
		process.stderr.write(
			`SKIP: no operating manual at ${MANUAL} yet — nothing to be stale.\n`,
		);
		return;
	}
	const { stale, report } = freshness();

	if (!stale) {
		console.log("Operating manual is fresh — nothing to file.");
		console.log(report.trim());
		return;
	}

	/* `triage` because none of the seven `takes:` values names a skill run: the
	 * fix is a manual-sync, so a session has to decide whether to run one now. */
	console.log(
		`Operating manual is stale. ${fileOrRefresh({
			title: TITLE,
			label: LABEL,
			labels: [LABEL, TAKES],
			body: body(report),
		})}`,
	);
}

if (require.main === module) main();

/* `freshness` is exported for check-cleared-trackers.js (mantahostels#1699), which must ask
 * THIS function whether the manual is still behind: a second reading of the
 * checker's exit alphabet could call the tracking issue cleared while the filer
 * disagrees. */
module.exports = { TITLE, LABEL, freshness };
