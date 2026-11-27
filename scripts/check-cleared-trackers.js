#!/usr/bin/env node

const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const { raiseGhFailure } = require("./lib/gh");
const { openTrackingIssue } = require("./lib/tracking-issue");
const { sectionBRange, sectionBWords } = require("./lib/doc-map");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root");
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
const { caught, orFallback } = require("./lib/caught.js");

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

/** @type {Tracker[]} */
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
					fs.readFileSync(path.join(worktreeRoot(), logPath), "utf8"),
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
		condition: () => redSuite.ciStillRed(),
		unfiledCondition: () => redSuite.newestCiRed(),
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
 * @param {Tracker} t
 * @param {Tally} tally
 */
function readTracker(t, tally) {
	/** @type {{ number: number, title: string } | null} */
	let issue;
	try {
		issue = openTrackingIssue({ title: t.title, label: t.label });
	} catch (e) {
		return raiseGhFailure(
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
 * @param {Tally["unfiled"]} unfiled
 */
function noteUnfiled(t, unfiled) {
	if (!t.unfiledCondition) return;
	const v = orFallback(() => t.unfiledCondition?.(), undefined);
	if (v?.held)
		unfiled.push({
			title: t.title,
			script: t.script,
			detail: v.detail,
		});
}

/**
 * @param {Tracker} t
 * @param {{ number: number, title: string }} issue
 * @param {Tally} tally
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
 * @param {import("./lib/check").Ctx} ctx
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
	for (const u of unfiled)
		ctx.fail(
			"CONDITION-UNFILED",
			`"${u.title}" holds (${u.detail}) but no tracking issue is open — ${u.script} may have failed silently`,
			u,
		);
}

/**
 * @param {import("./lib/check").Ctx} ctx
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
