#!/usr/bin/env node
/*
 * check-cleared-trackers.js — report a STANDING-CONDITION TRACKING ISSUE that is
 * still open although the condition it tracks no longer holds.
 *
 * Usage:  npm run check:cleared-trackers  [--notify] [--json]
 *
 * WHAT IT IS FOR (mantahostels#1699). scripts/lib/tracking-issue.js
 * exports openTrackingIssue, refresh and fileOrRefresh — file on the condition
 * arising, rewrite the body while it stands. There is NO CLOSE PATH, so every
 * reporter built on it does nothing at all when the condition clears.
 *
 * WHY A CHECKER AND NOT A CLOSER, ruled at mantahostels#1699 over the auto-close, on two
 * counts kept here because they are what a later session would have to overturn.
 * An auto-close carries no `**Outstanding:**` line, the ritual
 * the guard-issue-close core exists to enforce — and a close from inside a
 * workflow is out of that guard's reach entirely (it matches parsed Bash tool
 * calls only), so the ritual would be skipped invisibly rather than refused.
 * And the conditions flap, so a closer would have to arbitrate a condition a
 * human has already closed against; a report leaves that where it sits.
 *
 * IT SHARES THE FILER'S MEASUREMENT, and restates only the comparison. Each
 * entry imports the reporter's TITLE and LABEL, so the issue it looks for cannot
 * drift from the one that was filed, and calls the same function the filer
 * measures with — freshness(), parseCycles()/verdict(), sectionBWords(). What is
 * NOT shared is the threshold for two of the three: report-doc-map-budget.js
 * tests `words <= BUDGET_WORDS` inline in its main(), and
 * report-cycle-review-due.js decides inline which verdict kinds file. A changed
 * threshold has to be changed in both places.
 *
 * ORDER IS LOAD-BEARING: the tracking issue is looked up FIRST, and the
 * (expensive) `condition` evaluated only for a reporter whose issue is open —
 * so an unreadable condition is never reported about an issue nobody filed.
 * `unfiledCondition` is the one deliberate exception (mantahostels#2297): a red
 * suite is urgent, and report-red-suite.js files it only once a day, from the
 * daily repo-checks run (#1963), so a filer that failed or has not run yet
 * leaves a red nobody filed. For that one tracker a SEPARATE, CHEAP
 * condition is also read with NO issue open.
 *
 * DEGRADES TO SILENCE, NEVER TO "CLEARED". A condition that throws is reported
 * as unreadable, never as cleared. An unreachable gh leaves through lib/gh.js's
 * own SKIP. `unfiledCondition` fails open to silence on a throw instead — it
 * has no issue to report unreadable against.
 *
 * IT DOES NOT STAMP, so a cleared tracker is reported on every run until it is
 * closed. Deliberate at mantahostels#1699: a notice shown once can be missed in the session
 * it lands in, and nothing would ever raise it again.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reports an open tracking issue whose
 *            condition has cleared. It never closes one.
 * JUSTIFIED: fail-safe — no other checker here reads a tracking issue against
 *            its own condition, and a run that cannot evaluate a condition says
 *            so rather than calling the issue cleared.
 * DEFEAT:    none.
 */

const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const { raiseGhFailure } = require("./lib/gh");
const { openTrackingIssue } = require("./lib/tracking-issue");
const { sectionBRange, sectionBWords } = require("./lib/doc-map");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root");
const { cycleLogPath } = require("./lib/workflow-core-config");
const {
	parseRoadmap,
} = require("../.claude/skills/roadmap-edit/scripts/validate.js");

const manual = require("./report-manual-staleness");
const cycle = require("./report-cycle-review-due");
const budget = require("./report-doc-map-budget");
const redSuite = require("./report-red-suite");
const roadmapCeilings = require("./report-roadmap-ceilings");
const retro = require("./report-retro-due");
const bandDrift = require("./check-band-drift");
const { caught } = require("./lib/caught.js");

/**
 * @typedef {{
 *   script: string,
 *   title: string,
 *   label: string,
 *   condition: () => { held: boolean, detail: string },
 *   unfiledCondition?: () => { held: boolean, detail: string } | null,
 * }} Tracker
 */

/** @param {string} text */
function parseFirstLine(text) {
	const [line] = text.split("\n");
	if (line === undefined) throw new Error("split yielded no line");
	return line;
}

/**
 * The reporters built on lib/tracking-issue.js, one entry each.
 *
 * `condition` answers the reporter's own question — is it still true — and
 * returns the line a reader needs to judge the answer. It may throw; the caller
 * treats that as unreadable, never as cleared.
 *
 * @type {Tracker[]}
 */
const TRACKERS = [
	{
		script: "scripts/report-manual-staleness.js",
		title: manual.TITLE,
		label: manual.LABEL,
		condition: () => {
			const { stale, report } = manual.freshness();
			return {
				held: stale,
				detail:
					report.trim().split("\n").filter(Boolean).pop() || "(no output)",
			};
		},
	},
	{
		script: "scripts/report-cycle-review-due.js",
		title: cycle.TITLE,
		label: cycle.LABEL,
		condition: () => {
			const today = (process.env.CYCLE_TODAY || new Date().toISOString()).slice(
				0,
				10,
			);
			const logPath = cycleLogPath();
			const v = cycle.verdict(
				cycle.parseCycles(
					fs.readFileSync(path.join(hostRoot(), logPath), "utf8"),
					logPath,
				),
				today,
			);
			let detail = `verdict is "${v.kind}" (today ${today})`;
			if (v.kind === "current") {
				const [open] = v.open;
				if (open === undefined)
					throw new Error('a "current" cycle verdict names no open cycle');
				detail = `cycle ${open.n} runs to ${open.end} (today ${today})`;
			}
			return { held: !cycle.filesNothing(v.kind), detail };
		},
	},
	{
		script: "scripts/report-retro-due.js",
		title: retro.TITLE,
		label: retro.LABEL,
		// An unset N is the filer's SKIP, so an issue open under it is cleared.
		condition: () => {
			const today = retro.today();
			const v = retro.condition(today);
			if (v.skip !== null) return { held: false, detail: v.skip };
			return {
				held: v.due,
				detail: v.newest
					? `newest weekly run ${v.newest}, ${v.age} day(s) before ${today}`
					: `no weekly run recorded (today ${today})`,
			};
		},
	},
	{
		script: "scripts/report-doc-map-budget.js",
		title: budget.TITLE,
		label: budget.LABEL,
		condition: () => {
			const text = fs.readFileSync("docs/doc-map.md", "utf8");
			// sectionBWords returns 0 for a map with no "## Section B" heading, and
			// 0 is under budget — so without this the checker would call the
			// tracker cleared off a map it could not measure.
			if (!sectionBRange(text.split("\n")))
				throw new Error(
					'docs/doc-map.md carries no "## Section B" heading, so §B cannot be measured',
				);
			const words = sectionBWords(text);
			return {
				held: words > budget.BUDGET_WORDS,
				detail: `§B is ${words.toLocaleString("en-GB")} words against a ${budget.BUDGET_WORDS.toLocaleString("en-GB")}-word budget`,
			};
		},
	},
	{
		script: "scripts/report-roadmap-ceilings.js",
		title: roadmapCeilings.TITLE,
		label: roadmapCeilings.LABEL,
		condition: () => {
			const html = fs.readFileSync("docs/reference-roadmap.html", "utf8");
			const { ITEMS } = parseRoadmap(html);
			const rows = roadmapCeilings.overCeilingRows(ITEMS);
			// A capOk row is a ratified floor, not work, so it does not hold the
			// tracker open (mantahostels#3352) — the same test the reporter's own filing makes.
			return {
				held: roadmapCeilings.payable(rows).length > 0,
				detail: roadmapCeilings.verdict(rows),
			};
		},
	},
	{
		script: "scripts/report-red-suite.js",
		title: redSuite.TITLE,
		label: redSuite.LABEL,
		// The one condition here that is not repo state: it is read from the
		// Actions API, so it costs a `gh run list` plus one `gh run view` per
		// sweep it walks — paid only when the red-suite issue is open, the
		// lookup above running first.
		//
		// SO A gh OUTAGE REACHES THIS ONE AS AN UNREADABLE CONDITION, not as the
		// run-wide SKIP the header describes: that SKIP is raised by the tracking
		// -issue lookup, and this is the first condition to call gh after it. The
		// verdict is still never "cleared", which is what the degrade rule
		// protects.
		condition: () => redSuite.sweepStillRed(),
		// Never sweepStillRed() here — see the loop's own comment on why (mantahostels#2297).
		unfiledCondition: () => redSuite.newestSweepRed(),
	},
	{
		script: "scripts/check-band-drift.js",
		title: bandDrift.TITLE,
		label: bandDrift.LABEL,
		condition: bandDrift.trackerCondition,
	},
	{
		script: "scripts/check-band-drift.js",
		title: bandDrift.TOP_TITLE,
		label: bandDrift.LABEL,
		condition: bandDrift.topTrackerCondition,
	},
];

/**
 * @typedef {{
 *   cleared: { number: number, title: string, script: string, detail: string }[],
 *   unreadable: { number: number, title: string, script: string, reason: string }[],
 *   unfiled: { title: string, script: string, detail: string }[],
 *   standing: string[],
 *   openCount: number,
 * }} Tally
 */

/**
 * Looks up one reporter's tracking issue and files its condition's reading
 * into the tally.
 *
 * @param {Tracker} t
 * @param {Tally} tally accumulator: the tracker's reading is filed here
 */
function readTracker(t, tally) {
	/* The gh read is classified, not caught as a finding: a tracker nobody
	 * can reach is a SKIP for the whole run, never three "unreadable"
	 * lines. lib/tracking-issue.js throws execFileSync's raw error, so the
	 * SUBJECT/APPARATUS split lib/check.js runs on has to be applied here —
	 * GitHub down is the subject, anything else is the apparatus. */
	/** @type {{ number: number, title: string } | null} */
	let issue;
	try {
		issue = openTrackingIssue({ title: t.title, label: t.label });
	} catch (e) {
		raiseGhFailure(
			e,
			`Whether ${t.script}'s tracking issue is open is unknown, so no tracker is reported cleared.`,
		);
	}
	if (!issue) {
		noteUnfiled(t, tally.unfiled);
		return;
	}
	tally.openCount++;
	judgeOpen(t, issue, tally);
}

/**
 * @param {Tracker} t
 * @param {Tally["unfiled"]} unfiled accumulator: a held unfiled condition is pushed here
 */
function noteUnfiled(t, unfiled) {
	/* `unfiledCondition` is paid on every healthy run (no issue
	 * open), so it must be a cheap function, never `condition`'s expensive
	 * multi-sweep read (mantahostels#2297). Failed open on a throw — an apparatus
	 * fault must not read as "so it must have been filed". */
	if (!t.unfiledCondition) return;
	try {
		const v = t.unfiledCondition();
		if (v?.held)
			unfiled.push({
				title: t.title,
				script: t.script,
				detail: v.detail,
			});
	} catch {
		// Unreadable and unfiled: say nothing rather than guess.
	}
}

/**
 * Reads an open tracker's condition: standing, cleared or unreadable.
 *
 * @param {Tracker} t
 * @param {{ number: number, title: string }} issue
 * @param {Tally} tally accumulator: the issue goes to unreadable, standing or cleared
 */
function judgeOpen(t, issue, tally) {
	let verdict;
	try {
		verdict = t.condition();
	} catch (e) {
		const { message } = caught(e);
		tally.unreadable.push({
			number: issue.number,
			title: issue.title,
			script: t.script,
			reason: message ? parseFirstLine(String(message)) : String(e),
		});
		return;
	}

	if (verdict.held) tally.standing.push(`#${issue.number}`);
	else
		tally.cleared.push({
			number: issue.number,
			title: issue.title,
			script: t.script,
			detail: verdict.detail,
		});
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {Tally} tally
 */
function emitFindings(ctx, { cleared, unreadable, unfiled }) {
	for (const c of cleared)
		ctx.warn(
			"CLEARED-TRACKER",
			`#${c.number} "${c.title}" — ${c.script} reports ${c.detail}`,
			c,
		);
	for (const u of unreadable)
		ctx.warn(
			"UNREADABLE-CONDITION",
			`#${u.number} "${u.title}" — ${u.script} could not answer: ${u.reason}`,
			u,
		);
	/* FAIL, not WARN: this is not a stale filing to tidy up, it is the
	 * condition the filer exists to report standing with nobody told (mantahostels#2297). */
	for (const u of unfiled)
		ctx.fail(
			"CONDITION-UNFILED",
			`"${u.title}" holds (${u.detail}) but no tracking issue is open — ${u.script} may have failed silently`,
			u,
		);
}

/**
 * @param {import("./lib/check").CheckContext} ctx
 * @param {Tally} tally
 */
function printReport(ctx, { cleared, unreadable, unfiled }) {
	if (cleared.length > 0) {
		ctx.say(
			`CLEARED TRACKER (${cleared.length}) — open, but the condition it tracks no longer holds:`,
		);
		for (const c of cleared)
			ctx.say(
				`  #${c.number} ${c.title}\n` +
					`    ${c.script} now reports: ${c.detail}\n` +
					"    Nothing closes it for you — no reporter here has a close path.",
			);
		ctx.say(
			'\n  Read the issue before closing: a close needs an "**Outstanding:**" line,\n' +
				"  and a condition that cleared may yet re-arise, which refiles a fresh issue.\n",
		);
	}
	if (unreadable.length > 0) {
		ctx.say(`\nUNREADABLE CONDITION (${unreadable.length}):`);
		for (const u of unreadable)
			ctx.say(`  #${u.number} ${u.title}\n    ${u.script}: ${u.reason}`);
		ctx.say(
			"\n  Whether these are cleared is unknown — they are NOT reported as cleared.\n",
		);
	}
	if (unfiled.length > 0) {
		ctx.say(`\nCONDITION UNFILED (${unfiled.length}):`);
		for (const u of unfiled)
			ctx.say(
				`  ${u.title}\n    ${u.script} reports: ${u.detail}\n    No open issue tracks it — its filer may have failed to run.\n` +
					`    File it by hand — node ${u.script} — and read its own log to find out why it did not.`,
			);
	}
}

runCheck({
	name: "check-cleared-trackers",
	module: require("./lib/workflow-core-config.js").MANUAL_HALF,
	usage: `node ${scriptPath("check-cleared-trackers.js")} [--notify] [--json]`,
	run(ctx) {
		/** @type {Tally} */
		const tally = {
			cleared: [],
			unreadable: [],
			unfiled: [],
			standing: [],
			openCount: 0,
		};
		for (const t of TRACKERS) readTracker(t, tally);
		const { cleared, unreadable, unfiled, standing, openCount } = tally;

		emitFindings(ctx, tally);
		printReport(ctx, tally);

		return {
			okLine: openCount
				? `${openCount} tracking issue(s) open, every condition still standing${standing.length > 0 ? ` (${standing.join(", ")})` : ""}.`
				: `no tracking issue is open across ${TRACKERS.length} reporter(s).`,
			// Never "cleared tracker(s)": lib/check.js counts every WARN finding, so
			// that noun would summarise an UNREADABLE-CONDITION as a clearance —
			// the one thing this checker must never assert.
			noun: "tracking-issue finding(s)",
			data: {
				cleared,
				unreadable,
				unfiled,
				openCount,
				reporters: TRACKERS.length,
			},
		};
	},
});
