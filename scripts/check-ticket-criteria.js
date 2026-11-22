#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { ghIssueListAll, raiseGhFailure } = require("./lib/gh");
const {
	criteriaSection,
	isUnmet,
	taskItems,
} = require("./lib/ticket-criteria");

/**
 * @typedef {import("./lib/check").Ctx} Ctx
 * @typedef {{ number: number, title: string, body?: string | null,
 *   labels?: { name: string }[], stateReason?: string | null,
 *   closedAt?: string | null, url: string }} ClosedIssue
 * @typedef {{ number: number, title: string, url: string,
 *   closedAt?: string | null, total: number, unticked: number,
 *   items: string[] }} Unverified
 * @typedef {{ number: number, title: string, url: string, items: string[] }} Waived
 * @typedef {{ unverified: Unverified[], noCriteria: ClosedIssue[],
 *   waivedItems: Waived[] }} Buckets
 */

function readClosed() {
	try {
		return ghIssueListAll("closed issues", [
			"--state",
			"closed",
			"--json",
			"number,title,body,labels,stateReason,closedAt,url",
		]);
	} catch (e) {
		return raiseGhFailure(e);
	}
}

/**
 * @param {ClosedIssue} iss
 * @param {Buckets} buckets
 */
function classifyIssue(iss, buckets) {
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
	// lucmoseley/mantahostels#2490
	for (const i of unverified)
		ctx.fail(
			"UNVERIFIED",
			`#${i.number} ${i.title} — ${i.unticked}/${i.total} criteria unticked at close`,
			i,
			`UNVERIFIED\t#${i.number}`,
		);
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
