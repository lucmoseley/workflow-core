#!/usr/bin/env node
/*
 * check-ticket-criteria.js — periodic report on closed issues whose acceptance
 * criteria were never ticked off.
 *
 * Usage:
 *   node check-ticket-criteria.js [--warn] [--json]
 *
 * Backstop for the tracker doc's "Closing an issue with acceptance criteria"
 * rule: resolve-ticket.js and the guard-issue-close core refuse at close (#1640), so
 * what reaches this is a close by the GitHub UI or `gh api`, or one made before
 * those refusals. Same posture as check-issue-card-drift.js.
 *
 * THIS SCRIPT NEVER WRITES. A box ticked by a script asserts a verification
 * nobody performed, which is worse than the unticked box it replaced.
 *
 * What it reports:
 *   UNVERIFIED    closed as completed, has criteria, at least one still `- [ ]`.
 *                 Counts toward the exit code.
 *   WAIVED        unticked but marked `**waived:** <why>` — checked, found not
 *                 met, left unticked on purpose. Reported only.
 *   NO-CRITERIA   closed, `kind:ticket`, no criteria section — the heading
 *                 drifted, or the ticket was hand-opened rather than published
 *                 by /to-tickets. Reported only.
 *
 * Issues closed as NOT PLANNED are skipped: abandoned, not delivered.
 *
 * Requires the `gh` CLI, authenticated.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js. UNVERIFIED is a
 * FAIL finding and gates; WAIVED and NO-CRITERIA are intrinsic WARN findings, so
 * they report without ever changing the exit code. An unreachable GitHub is SKIP
 * (exit 0); any other gh failure is BROKEN (exit 2, mantahostels#164 —
 * the ticket that drew that line).
 */

const { runCheck } = require("./lib/check");
const { ghIssueListAll, raiseGhFailure } = require("./lib/gh");
const {
	criteriaSection,
	isUnmet,
	taskItems,
} = require("./lib/ticket-criteria");

/**
 * @typedef {import("./lib/check").CheckContext} Ctx
 * @typedef {{ number: number, title: string, body?: string | null,
 *   labels?: { name: string }[], stateReason?: string | null,
 *   closedAt?: string | null, url: string }} ClosedIssue the fields
 *   readClosed() asks gh for
 * @typedef {{ number: number, title: string, url: string,
 *   closedAt?: string | null, total: number, unticked: number,
 *   items: string[] }} Unverified
 * @typedef {{ number: number, title: string, url: string, items: string[] }} Waived
 * @typedef {{ unverified: Unverified[], noCriteria: ClosedIssue[],
 *   waivedItems: Waived[] }} Buckets
 */

/** Every closed issue, or a raised gh failure. */
function readClosed() {
	try {
		return ghIssueListAll("closed issues", [
			"--state",
			"closed",
			"--json",
			"number,title,body,labels,stateReason,closedAt,url",
		]);
	} catch (e) {
		raiseGhFailure(e);
	}
}

/**
 * @param {ClosedIssue} iss
 * @param {Buckets} buckets accumulator: the issue is pushed onto each bucket it belongs in
 */
function classifyIssue(iss, buckets) {
	// Abandoned, not delivered. Nothing to verify.
	if ((iss.stateReason || "").toUpperCase() === "NOT_PLANNED") return;

	const labels = (iss.labels || []).map(
		(/** @type {{ name: string }} */ l) => l.name,
	);
	const section = criteriaSection(iss.body);
	const items = section === null ? [] : taskItems(section);

	if (items.length === 0) {
		if (labels.includes("kind:ticket")) buckets.noCriteria.push(iss);
		return;
	}

	const waived = items.filter((i) => !i.ticked && i.waived);
	if (waived.length > 0)
		buckets.waivedItems.push({
			number: iss.number,
			title: iss.title,
			url: iss.url,
			items: waived.map((i) => i.text),
		});

	const open = items.filter(isUnmet);
	if (open.length > 0)
		buckets.unverified.push({
			number: iss.number,
			title: iss.title,
			url: iss.url,
			closedAt: iss.closedAt,
			total: items.length,
			unticked: open.length,
			items: open.map((i) => i.text),
		});
}

/**
 * @param {Ctx} ctx
 * @param {Buckets} buckets
 */
function raiseFindings(ctx, { unverified, noCriteria, waivedItems }) {
	/* Issue number and tag only (mantahostels#2490). The title moves, and so does the
	 * unticked/total pair — a ticket going from 3/7 to 2/7 is the same finding
	 * partly drained, not a new one. */
	for (const i of unverified)
		ctx.fail(
			"UNVERIFIED",
			`#${i.number} ${i.title} — ${i.unticked}/${i.total} criteria unticked at close`,
			i,
			`UNVERIFIED\t#${i.number}`,
		);
	/* Reported, never gating: a waiver is someone having checked and said why,
	 * and a missing criteria section is a shape problem on an already-closed
	 * ticket. Both are WARN findings so they ride in the --json envelope and the
	 * annotations without ever changing the exit code. */
	for (const i of waivedItems)
		ctx.warn(
			"WAIVED",
			`#${i.number} ${i.title} — ${i.items.length} criterion/criteria waived`,
			i,
			`WAIVED\t#${i.number}`,
		);
	for (const i of noCriteria)
		ctx.warn(
			"NO-CRITERIA",
			`#${i.number} ${i.title} — kind:ticket closed with no acceptance criteria`,
			{ number: i.number, title: i.title, url: i.url },
			`NO-CRITERIA\t#${i.number}`,
		);
}

/**
 * @param {Ctx} ctx
 * @param {Unverified[]} unverified
 */
function sayUnverified(ctx, unverified) {
	if (unverified.length === 0) return;
	const boxes = unverified.reduce((n, i) => n + i.unticked, 0);
	ctx.say(
		`UNVERIFIED (${unverified.length} issue(s), ${boxes} unticked criteri${
			boxes === 1 ? "on" : "a"
		}):`,
	);
	for (const i of unverified) {
		ctx.say(
			`  #${i.number} ${i.title}\n    ${i.unticked}/${i.total} unticked, closed ${(
				i.closedAt || ""
			).slice(0, 10)}\n    ${i.url}`,
		);
		for (const t of i.items) ctx.say(`      [ ] ${t}`);
	}
	ctx.say(
		"\n  Closed without the criteria being ticked. Do NOT batch-tick these:\n" +
			"  a tick asserts the criterion was checked, so each one needs a human or\n" +
			"  a session to actually verify it. Where a criterion was deliberately\n" +
			"  dropped, say so in a comment and leave the box unticked.\n",
	);
}

/**
 * @param {Ctx} ctx
 * @param {Waived[]} waivedItems
 */
function sayWaived(ctx, waivedItems) {
	if (waivedItems.length === 0) return;
	ctx.say(
		`WAIVED (${waivedItems.length}) — checked, not met, deliberately left unticked:`,
	);
	for (const i of waivedItems) {
		ctx.say(`  #${i.number} ${i.title}`);
		for (const t of i.items) ctx.say(`      [ ] ${t}`);
	}
	ctx.say("");
}

/**
 * @param {Ctx} ctx
 * @param {ClosedIssue[]} noCriteria
 */
function sayNoCriteria(ctx, noCriteria) {
	if (noCriteria.length === 0) return;
	ctx.say(
		`NO-CRITERIA (${noCriteria.length}) — \`kind:ticket\`, no acceptance criteria:`,
	);
	for (const i of noCriteria) ctx.say(`  #${i.number} "${i.title}"`);
	ctx.say(
		"  Either the heading drifted from `## Acceptance criteria`, or the ticket\n" +
			"  was opened by hand rather than published by /to-tickets. Reported only.\n",
	);
}

runCheck({
	name: "ticket-criteria",
	usage: "node check-ticket-criteria.js [--warn] [--json]",
	run(ctx) {
		const closed = readClosed();

		/** @type {Buckets} */
		const buckets = { unverified: [], noCriteria: [], waivedItems: [] };
		for (const iss of closed) classifyIssue(iss, buckets);
		const { unverified, noCriteria, waivedItems } = buckets;

		// --- report -------------------------------------------------------------

		raiseFindings(ctx, buckets);

		ctx.say(
			`Checked ${closed.length} closed issue(s) for acceptance criteria.\n`,
		);

		sayUnverified(ctx, unverified);
		sayWaived(ctx, waivedItems);
		sayNoCriteria(ctx, noCriteria);

		return {
			okLine: "no closed ticket has unticked acceptance criteria.",
			noun:
				unverified.length > 0
					? "closed ticket(s) with unticked criteria"
					: "advisory finding(s) — waived criteria or a missing criteria section",
			data: {
				unverified,
				noCriteria: noCriteria.map((i) => ({
					number: i.number,
					title: i.title,
					url: i.url,
				})),
				waived: waivedItems,
				unverifiedCount: unverified.length,
			},
		};
	},
});
