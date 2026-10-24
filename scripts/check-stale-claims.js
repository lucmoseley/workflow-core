#!/usr/bin/env node
/*
 * check-stale-claims.js — reports an open issue that has been assigned for a
 * long time with no sign anyone is working it.
 *
 * The assignee is the claim. /wayfinder's frontier query drops an assigned issue
 * outright; scripts/pick-next.js drops it only where the arbiter holds a live
 * session's claim on it (mantahostels#645). So an assignee written onto work nobody has
 * started still removes that work from the wayfinder frontier — the failure
 * mantahostels#270 measured, where spin-offs filed for later were claimed by the session
 * that filed them.
 *
 * Prevention is the rule in docs/agents/issue-tracker.md §Claiming — a session
 * assigns itself to the issue it is working now, and creates unassigned
 * anything it files for later. Nothing can enforce it: an assignment is one
 * `gh` call and looks identical whichever issue the session is really working.
 *
 * THIS SCRIPT NEVER WRITES, and never unassigns. Whether a claim is dead is a
 * judgement about a person's intent, not a fact on the timeline: a session may
 * legitimately hold an issue across weeks of a slow-moving decision. Same shape
 * mantahostels#111 settled for `urgent`'s decay — the machine displays it, a person acts.
 *
 * WARN, never FAIL. Its verdict is a function of world state, not of the commit,
 * so gating a build on it would make CI's colour depend on when it ran.
 *
 * One list call, then one timeline call per ASSIGNED issue — the only place the
 * assignment date lives, the list payload carrying `updated_at` and not it. The
 * fan-out is bounded by the assignee count, 3 of 42 open issues on 12 August
 * 2026, so it stays sequential rather than reaching for ghApiSlurpAsync.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: an unreachable
 * GitHub is SKIP (exit 0) whichever call hit it, any other gh failure on the
 * list call is BROKEN (exit 2, mantahostels#164 — the ticket that drew that line), and a
 * stale or unreadable claim is a WARN finding (exit 0).
 *
 * Usage: node check-stale-claims.js [--json]
 */

const { runCheck } = require("./lib/check");
const {
	ghApiSlurp,
	ghOpenIssues,
	collapsedFailureLine,
	errLine,
	ghFailureReason,
	groupByRepeatedError,
	raiseGhFailure,
} = require("./lib/gh");

/**
 * `assignees` is the REST issues payload's own array field — present and
 * empty on an unassigned issue, never omitted.
 * @typedef {{number: number, title: string, html_url: string, pull_request?: unknown,
 *   assignees: {login: string}[]}} RawIssue
 * @typedef {{event: string, created_at: string}} TimelineEvent
 * @typedef {{number: number, title: string, url: string, assignees: string[]}} Claim
 */

/*
 * How long a claim may sit untouched before it is worth a look. A FIRST GUESS,
 * tied to no evidence. It is not the `waiting:external` stall threshold
 * (mantahostels#956), which answers how long an outside party stays silent — a
 * different question from how long a session sits on an issue; see
 * docs/agents/issue-tracker.md. Re-derive it the moment there is a real distribution of claim
 * ages to derive it from.
 */
const STALE_CLAIM_DAYS = 14;

/*
 * Timeline events that count as someone working the issue. Deliberately narrow:
 * a label, a title edit or a sub-issue link is upkeep anyone can do in passing,
 * and counting those would let a claim look alive because a triage pass touched
 * it. `referenced` and `committed` are how a commit naming the issue appears.
 */
const WORK_EVENTS = new Set([
	"commented",
	"referenced",
	"committed",
	"cross-referenced",
]);

/**
 * The newest of `events` that `keep` accepts, or undefined.
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

/**
 * Reads one claimed issue's timeline and sorts it: a stale claim, an
 * unreadable one, or neither (null).
 * @param {Claim} iss
 */
function classifyClaim(iss) {
	/** @type {TimelineEvent[]} */
	let events = [];
	try {
		events = ghApiSlurp([
			`repos/{owner}/{repo}/issues/${iss.number}/timeline?per_page=100`,
		]);
	} catch (e) {
		/* An unreachable GitHub ends the whole run — a partial scan reported as
		 * a result is the failure mantahostels#164 left in place for months. Anything else
		 * is one issue this run could not examine, which is a finding about
		 * that issue rather than a fault in the check. */
		if (ghFailureReason(e) === "unreachable")
			raiseGhFailure(e, "No stale-claim conclusion drawn.");
		return { unreadable: { ...iss, reason: errLine(e) } };
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
 * Raises a WARN per stale and unreadable claim, then prints both lists.
 * @param {import("./lib/check").CheckContext} ctx
 * @param {(Claim & {ageDays: number, assignedAt: string})[]} stale
 * @param {(Claim & {reason: string})[]} unreadable
 */
function reportFindings(ctx, stale, unreadable) {
	for (const i of stale)
		ctx.warn(
			"STALE-CLAIM",
			`#${i.number} ${i.title} — claimed by ${i.assignees.join(", ")} for ${Math.floor(i.ageDays)} days, nothing since`,
			i,
			/* The age is deliberately OUT of the key (mantahostels#2490): it climbs a day at a
			 * time, so a key carrying it would reprint every standing stale claim
			 * every day. A re-assignment is a new claim, so the assignees are in. */
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
		for (const g of collapsed) ctx.say(collapsedFailureLine(g));
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
			// Open only: a closed issue's assignee records who did the work, not a claim.
			issues = ghOpenIssues();
		} catch (e) {
			raiseGhFailure(e, "No stale-claim conclusion drawn.");
		}

		const claimed = issues
			.filter((i) => !i.pull_request) // one number space, two kinds of thing
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
