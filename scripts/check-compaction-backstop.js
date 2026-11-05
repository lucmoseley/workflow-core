#!/usr/bin/env node
/*
 * check-compaction-backstop.js — the evidence for moving the 10-compaction
 * backstop (#4410): closed build units binned by how often they compacted,
 * against the follow-ups their specs drew.
 *
 * Usage:  node scripts/check-compaction-backstop.js [--days <n>] [--json]
 *
 * Reads the `kind:ticket` issues closed in the last n days (30 by default).
 * A unit's count is the sum of the `**Compactions:** <n>` lines on all its
 * comments, so a unit built across two sessions — a backstop hand-off, then a
 * resolution — counts both. A unit with no such line closed before the log
 * existed, or by hand, and is counted apart, never binned.
 *
 * A FOLLOW-UP is a sub-issue of the unit's spec filed after the unit closed.
 * It goes to each unit it cites, by `#<n>` or by a sha the unit's comments
 * name, split evenly among them; one citing none is split evenly across every
 * unit of the spec that had closed before it was filed. Unbinned units take
 * their share too, so a follow-up citing one is not moved onto a logged one.
 *
 * Bins: 0, 1, 2–3, 4–6, 7–10, 11+. The 0 bin is beside the spec's five, as a
 * baseline for the rest.
 *
 * A report, run by `npm run status`: it raises no finding and gates nothing,
 * exit 0. SKIP where the tracker will not answer.
 */

const { runCheck } = require("./lib/check");
const { ghApiSlurp, parseErrLine } = require("./lib/gh.js");
const { citedIssues } = require("./lib/cited-issues.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const COMPACTIONS_RE = /^[ \t]*\*\*Compactions:\*\*[ \t]*(\d+)/gm;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;

/** @type {ReadonlyArray<{label: string, min: number, max: number}>} */
const BINS = [
	{ label: "0", min: 0, max: 0 },
	{ label: "1", min: 1, max: 1 },
	{ label: "2–3", min: 2, max: 3 },
	{ label: "4–6", min: 4, max: 6 },
	{ label: "7–10", min: 7, max: 10 },
	{ label: "11+", min: 11, max: Number.POSITIVE_INFINITY },
];

/**
 * @typedef {{ number: number, closedAt: number, spec: number | null,
 *   compactions: number | null, shas: string[] }} Unit
 *   `compactions` null where no comment carries the line
 */

/** @param {string} url */
const issueOfUrl = (url) => {
	const m = /\/issues\/(\d+)$/.exec(url ?? "");
	return m ? Number(m[1]) : null;
};

/**
 * @param {{ body?: string | null }[]} comments
 * @returns {{ compactions: number | null, shas: string[] }}
 */
function readComments(comments) {
	let compactions = null;
	const shas = new Set();
	for (const { body } of comments) {
		for (const m of (body ?? "").matchAll(COMPACTIONS_RE))
			compactions = (compactions ?? 0) + Number(m[1]);
		for (const m of (body ?? "").matchAll(SHA_RE)) shas.add(m[0]);
	}
	return { compactions, shas: [...shas] };
}

/**
 * Whether `text` cites `unit`, by number or by a sha its comments name,
 * either spelling being a prefix of the other.
 * @param {string} text
 * @param {Unit} unit
 */
function cites(text, unit) {
	if (citedIssues(text).has(unit.number)) return true;
	const words = [...text.matchAll(SHA_RE)].map((m) => m[0]);
	return words.some((w) =>
		unit.shas.some((s) => s.startsWith(w) || w.startsWith(s)),
	);
}

/**
 * Each unit's follow-up share, keyed by unit number.
 * @param {Unit[]} units
 * @param {Map<number, { number: number, created_at: string, body?: string | null }[]>} subsBySpec
 */
function attribute(units, subsBySpec) {
	/** @type {Map<number, number>} */
	const share = new Map(units.map((u) => [u.number, 0]));
	for (const [spec, subs] of subsBySpec) {
		const ofSpec = units.filter((u) => u.spec === spec);
		for (const f of subs) {
			const filed = Date.parse(f.created_at);
			const before = ofSpec.filter(
				(u) => u.number !== f.number && u.closedAt < filed,
			);
			if (before.length === 0) continue;
			const cited = before.filter((u) => cites(f.body ?? "", u));
			const to = cited.length > 0 ? cited : before;
			for (const u of to)
				share.set(u.number, (share.get(u.number) ?? 0) + 1 / to.length);
		}
	}
	return share;
}

/**
 * @param {Unit[]} units
 * @param {Map<number, number>} share
 */
function binUnits(units, share) {
	return BINS.map((b) => {
		const inBin = units.filter(
			(u) =>
				u.compactions !== null &&
				u.compactions >= b.min &&
				u.compactions <= b.max,
		);
		const followUps = inBin.reduce(
			(sum, u) => sum + (share.get(u.number) ?? 0),
			0,
		);
		return {
			bin: b.label,
			units: inBin.length,
			followUps,
			perUnit: inBin.length > 0 ? followUps / inBin.length : null,
		};
	});
}

/** @param {number} x */
const fixed = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(2));

runCheck({
	name: "compaction-backstop",
	usage: "node scripts/check-compaction-backstop.js [--days <n>] [--json]",
	valueFlags: ["--days"],
	run(ctx) {
		const days = ctx.numberValue("--days", DEFAULT_DAYS, "positive");
		const since = Date.now() - days * DAY_MS;
		/**
		 * @param {string[]} args
		 * @returns {any[]}
		 */
		const read = (args) => {
			try {
				return ghApiSlurp(args);
			} catch (e) {
				return ctx.skip(`the tracker would not answer (${parseErrLine(e)}).`);
			}
		};
		const closed = read([
			`repos/{owner}/{repo}/issues?state=closed&labels=kind:ticket&since=${new Date(since).toISOString()}&per_page=100`,
		]).filter(
			(i) => !i.pull_request && i.closed_at && Date.parse(i.closed_at) >= since,
		);
		/** @type {Unit[]} */
		const units = closed.map((i) => ({
			number: i.number,
			closedAt: Date.parse(i.closed_at),
			spec: issueOfUrl(i.parent_issue_url),
			...readComments(
				read([`repos/{owner}/{repo}/issues/${i.number}/comments?per_page=100`]),
			),
		}));
		const specs = [
			...new Set(units.map((u) => u.spec).filter((s) => s !== null)),
		];
		const subsBySpec = new Map(
			specs.map((s) => [
				/** @type {number} */ (s),
				read([`repos/{owner}/{repo}/issues/${s}/sub_issues?per_page=100`]),
			]),
		);
		const share = attribute(units, subsBySpec);
		const bins = binUnits(units, share);
		const unlogged = units.filter((u) => u.compactions === null).length;

		ctx.say(
			`Build units closed in the last ${days} day(s), by autocompactions (the backstop is 10):\n`,
		);
		for (const b of bins)
			ctx.say(
				`  ${b.bin.padEnd(5)} ${String(b.units).padStart(3)} unit(s), ${fixed(b.followUps)} follow-up(s), ${b.perUnit === null ? "—" : fixed(b.perUnit)} per unit\n`,
			);
		ctx.say(
			`  ${unlogged} unit(s) carry no **Compactions:** line and are not binned.\n`,
		);
		return {
			okLine: `${units.length} build unit(s) closed in the last ${days} day(s), binned by autocompactions.`,
			noun: "finding(s)",
			data: { days, bins, unlogged },
		};
	},
});
