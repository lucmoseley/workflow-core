#!/usr/bin/env node
/*
 * check-chrome-tab-leftovers.js — which Chrome children left a tab open in
 * the founder's Chrome that neither a hold nor a give-up explains (#5385)?
 *
 * Usage:
 *   node check-chrome-tab-leftovers.js [--since <days>] [--turnaround] [--json] [--warn]
 *
 * lib/chrome-child-census.js reads and classes every child on the machine.
 * Each unexplained child is one WARN finding, keyed
 * `UNEXPLAINED-TAB<TAB>sessionId<TAB>seat<TAB>title (url); …`.
 * Held and given-up children are counted on their own lines, not findings.
 *
 * THE WINDOW is the transcripts written in the last `--since` days (30 by
 * default; repo-checks.js passes its widening window), never before the
 * store's first recorded launch: an older child ran under a launcher that
 * kept no record, #5349's census. A session whose earlier transcript fell
 * outside the window is read from its later one alone.
 *
 * `--turnaround` prints, from the closed log, each held tab's time from
 * `heldSince` to its close and what closed it, one line each: the evidence
 * for revisiting the hold. It is hand-run only.
 */

const { now, runCheck } = require("./lib/check.js");
const { scriptPath } = require("./lib/script-path.js");
const { readCensus, readTurnarounds } = require("./lib/chrome-child-census.js");
const { named } = require("./lib/chrome-child.js");
const { HOLD_MS, readFirstLaunch } = require("./lib/chrome-child-store.js");
const DAY_MS = 86_400_000;

/** @typedef {import("./lib/check.js").Ctx} Ctx */

/** @param {Ctx} ctx */
function turnaround(ctx) {
	const lines = readTurnarounds();
	for (const t of lines)
		ctx.say(
			`${t.sessionId}\t${t.heldSince}\t${t.closedAt}\t${t.minutes} min\t${t.by}`,
		);
	return {
		okLine: `${lines.length} held tab(s) closed, read from the closed log.`,
	};
}

/** @param {Ctx} ctx */
async function run(ctx) {
	if (ctx.has("--turnaround")) return turnaround(ctx);
	/* Untraced: an ad-hoc run looks back a month. */
	const days = ctx.numberValue("--since", 30, "positive");
	const firstLaunch = readFirstLaunch();
	if (firstLaunch === null)
		ctx.skip("no Chrome child has run under the recording launcher yet.");
	const fromMs = Math.max(now() - days * DAY_MS, firstLaunch);
	const census = await readCensus(fromMs);
	if (census.listed === 0)
		ctx.skip(
			`no seat's projects/ could be read (${[...census.unreadable, ...census.absent].join("; ")}).`,
		);
	for (const dir of census.unreadable)
		ctx.warn(
			"CENSUS-UNREAD",
			`${dir} could not be read, so its Chrome children went uncounted.`,
			{ dir },
			`CENSUS-UNREAD\t${dir}`,
		);
	const of = (
		/** @type {import("./lib/chrome-child-census.js").ChildClass} */ c,
	) => census.children.filter((child) => child.class === c);
	const unexplained = of("unexplained");
	for (const child of unexplained) {
		const tabs = child.left.map(named).join("; ");
		const remedy = child.recorded
			? `Close with: node ${scriptPath("claude-child.js")} chrome-close --session ${child.sessionId}`
			: "No launcher record names it, so no closer can reach it: close it in Chrome by hand.";
		ctx.warn(
			"UNEXPLAINED-TAB",
			`session ${child.sessionId} on ${child.seat} left ${child.left.length} tab(s) open: ${tabs}. ${remedy}`,
			child,
			`UNEXPLAINED-TAB\t${child.sessionId}\t${child.seat}\t${tabs}`,
		);
	}
	const hours = HOLD_MS / 3_600_000;
	ctx.say(
		`held: ${of("held").length} child(ren) holding a hand-over tab within its ${hours} h hold.`,
	);
	ctx.say(
		`given up: ${of("given-up").length} child(ren) whose tabs no closer could close.`,
	);
	const counted = census.children.length - of("running").length;
	const since = new Date(fromMs).toISOString();
	if (ctx.findings.length === 0)
		return {
			okLine: `no Chrome child since ${since} left a tab unexplained (${counted} counted, ${of("clean").length} clean).`,
		};
	return {
		noun: "Chrome child(ren) with a tab left unexplained",
		count: unexplained.length,
		data: { since, counted },
	};
}

const SPEC = {
	name: "chrome-tab-leftovers",
	usage:
		"node check-chrome-tab-leftovers.js [--since <days>] [--turnaround] [--json] [--warn]",
	valueFlags: ["--since"],
	flags: ["--turnaround"],
	run,
};

const main = () => runCheck(SPEC);

module.exports = { main };
if (require.main === module) main();
