#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const {
	ghApiSlurp,
	ghOpenIssues,
	buildCollapsedFailureLine,
	parseErrLine,
	parseGhFailureReason,
	groupByRepeatedError,
	raiseGhFailure,
} = require("./lib/gh");

/**
 * @typedef {{number: number, title: string, html_url: string, pull_request?: unknown,
 *   assignees: {login: string}[]}} RawIssue
 * @typedef {{event: string, created_at: string}} TimelineEvent
 * @typedef {{number: number, title: string, url: string, assignees: string[]}} Claim
 */

const STALE_CLAIM_DAYS = 14;

const WORK_EVENTS = new Set([
	"commented",
	"referenced",
	"committed",
	"cross-referenced",
]);

/**
 * @param {TimelineEvent[]} events
 * @param {(e: TimelineEvent) => boolean} keep
 */
function latestEvent(events, keep) {
	return events
		.filter(keep)
		.sort(
			(a, b) =>
				new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
		)[0];
}

/** @param {Claim} iss */
function classifyClaim(iss) {
	/** @type {TimelineEvent[]} */
	let events = [];
	try {
		events = ghApiSlurp([
			`repos/{owner}/{repo}/issues/${iss.number}/timeline?per_page=100`,
		]);
	} catch (e) {
		if (parseGhFailureReason(e) === "unreachable")
			raiseGhFailure(e, "No stale-claim conclusion drawn.");
		return { unreadable: { ...iss, reason: parseErrLine(e) } };
	}

	const assigned = latestEvent(events, (e) => e.event === "assigned");
	if (!assigned) {
		return {
			unreadable: {
				...iss,
				reason: "no `assigned` event on the timeline",
			},
		};
	}

	const assignedAt = new Date(assigned.created_at).getTime();
	const ageDays = (Date.now() - assignedAt) / 864e5;
	if (ageDays < STALE_CLAIM_DAYS) return null;

	const worked = latestEvent(
		events,
		(e) =>
			WORK_EVENTS.has(e.event) && new Date(e.created_at).getTime() > assignedAt,
	);
	if (worked) return null;

	return { stale: { ...iss, ageDays, assignedAt: assigned.created_at } };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {(Claim & {ageDays: number, assignedAt: string})[]} stale
 * @param {(Claim & {reason: string})[]} unreadable
 */
function reportFindings(ctx, stale, unreadable) {
	for (const i of stale)
		ctx.warn(
			"STALE-CLAIM",
			`#${i.number} ${i.title} — claimed by ${i.assignees.join(", ")} for ${Math.floor(i.ageDays)} days, nothing since`,
			i,
			// lucmoseley/mantahostels#2490
			`STALE-CLAIM\t#${i.number}\t${[...i.assignees].sort().join(",")}`,
		);
	for (const i of unreadable)
		ctx.warn(
			"UNREADABLE",
			`#${i.number} ${i.title} — assigned to ${i.assignees.join(", ")}, claim age unreadable (${i.reason})`,
			i,
			`UNREADABLE\t#${i.number}`,
		);

	if (stale.length > 0) {
		ctx.say(
			`STALE-CLAIM (${stale.length}) — assigned over ${STALE_CLAIM_DAYS} days ago, no comment or commit since:`,
		);
		for (const i of stale)
			ctx.say(
				`  #${i.number} ${i.title}\n    ${i.assignees.join(", ")}, ${Math.floor(i.ageDays)} days\n    ${i.url}`,
			);
	}
	if (unreadable.length > 0) {
		ctx.say(`\nUNREADABLE (${unreadable.length}) — claim age unknown:`);
		const { expanded, collapsed } = groupByRepeatedError(
			unreadable,
			(i) => i.reason,
		);
		for (const i of expanded)
			ctx.say(`  #${i.number} ${i.title}\n    ${i.reason}\n    ${i.url}`);
		for (const g of collapsed) ctx.say(buildCollapsedFailureLine(g));
	}
	if (stale.length > 0 || unreadable.length > 0)
		ctx.say(
			"\n  Decide whether anyone is actually working these, then release the\n" +
				"  ones nobody is: gh issue edit <n> --remove-assignee <login>\n" +
				"  This check never unassigns — a long-held claim on a slow decision\n" +
				"  looks the same from here as an abandoned one.\n",
		);
}

runCheck({
	name: "stale-claims",
	usage: "node check-stale-claims.js [--json]",
	run(ctx) {
		/** @type {RawIssue[]} */
		let issues = [];
		try {
			issues = ghOpenIssues();
		} catch (e) {
			raiseGhFailure(e, "No stale-claim conclusion drawn.");
		}

		const claimed = issues
			.filter((i) => !i.pull_request)
			.filter((i) => i.assignees.length)
			.map((i) => ({
				number: i.number,
				title: i.title,
				url: i.html_url,
				assignees: i.assignees.map((a) => a.login),
			}));

		const stale = [];
		const unreadable = [];

		for (const iss of claimed) {
			const verdict = classifyClaim(iss);
			if (verdict?.stale) stale.push(verdict.stale);
			if (verdict?.unreadable) unreadable.push(verdict.unreadable);
		}

		ctx.say(`Checked ${claimed.length} assigned open issue(s).\n`);

		reportFindings(ctx, stale, unreadable);

		return {
			okLine: `every one of ${claimed.length} assigned open issue(s) was claimed within ${STALE_CLAIM_DAYS} days or worked since.`,
			noun: "probably-dead claim(s)",
			data: {
				stale,
				staleCount: stale.length,
				unreadable,
				claimed: claimed.length,
				thresholdDays: STALE_CLAIM_DAYS,
			},
		};
	},
});
