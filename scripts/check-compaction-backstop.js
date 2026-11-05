#!/usr/bin/env node
/*
 * check-compaction-backstop.js — the evidence for moving the autocompaction
 * backstop (#4410): closed build units binned by how often they compacted,
 * against the follow-ups their specs drew.
 *
 * Usage:  node scripts/check-compaction-backstop.js [--days <n>] [--json]
 *
 * Reads the `kind:ticket` issues closed in the last n days. A unit's count is
 * the sum of the `**Compactions:** <n>` lines on all its comments, so a unit
 * built across two sessions — a backstop hand-off, then a resolution — counts
 * both. A unit with no such line closed before the log existed, or by hand,
 * and is counted apart, never binned.
 *
 * A FOLLOW-UP is a sub-issue of the unit's spec filed after the unit closed.
 * Its candidates are every closed `kind:ticket` of that spec closed before it
 * was filed, inside the window or not. It goes to each candidate it cites — by
 * `#<n>`, or by the sha of a commit on HEAD citing that ticket — split evenly
 * among them; one citing none is split evenly across all its candidates. Only
 * the window's logged units are binned, so a share going to a unit outside
 * the window or with no line is counted nowhere.
 *
 * Bins: 0, 1, 2–3, 4–6, 7–10, 11+, the last two split at the backstop. The
 * spec's five are untraced (#4410 §Values); 0 is beside them as a baseline.
 *
 * A report, run by `npm run status`: it raises no finding and gates nothing,
 * exit 0. SKIP where the tracker or git will not answer. It reads one comment
 * page per unit closed in the window, so it is among status's slower checks.
 */

const { now, runCheck } = require("./lib/check");
const { ghApiSlurp, parseErrLine } = require("./lib/gh.js");
const { execGit } = require("./lib/git.js");
const { citedIssues } = require("./lib/cited-issues.js");
const {
	COMPACTION_BACKSTOP,
	COMPACTIONS_LINE_RE,
} = require("./lib/compaction-set.js");
const { caught } = require("./lib/caught.js");

const DAY_MS = 24 * 60 * 60 * 1000;
/* Untraced: a month of closes, a guess at enough units to bin. */
const DEFAULT_DAYS = 30;
const SHA_PREFIX_RE = /\b[0-9a-f]{7,40}\b/g;
/* A commit's full sha, then its message, one record per commit. */
const LOG_FORMAT = "--format=%x1e%H%x1f%B";

/** @type {ReadonlyArray<{label: string, min: number, max: number}>} */
const BINS = [
	{ label: "0", min: 0, max: 0 },
	{ label: "1", min: 1, max: 1 },
	{ label: "2–3", min: 2, max: 3 },
	{ label: "4–6", min: 4, max: 6 },
	{ label: `7–${COMPACTION_BACKSTOP}`, min: 7, max: COMPACTION_BACKSTOP },
	{
		label: `${COMPACTION_BACKSTOP + 1}+`,
		min: COMPACTION_BACKSTOP + 1,
		max: Number.POSITIVE_INFINITY,
	},
];

/**
 * @typedef {{ number: number, closedAt: number, spec: number | null,
 *   compactions: number | null }} Unit
 *   `compactions` null where no comment carries the line
 * @typedef {{ number: number, closedAt: number }} Candidate
 * @typedef {{ number: number, state: string, created_at: string,
 *   closed_at?: string | null, body?: string | null,
 *   labels?: { name: string }[] }} SubIssue
 */

/** @param {string} url */
const issueOfUrl = (url) => {
	const m = /\/issues\/(\d+)$/.exec(url ?? "");
	return m ? Number(m[1]) : null;
};

/** @param {{ body?: string | null }[]} comments */
function sumCompactions(comments) {
	let compactions = null;
	for (const { body } of comments)
		for (const m of (body ?? "").matchAll(COMPACTIONS_LINE_RE))
			compactions = (compactions ?? 0) + Number(m[1]);
	return compactions;
}

/**
 * Each ticket's commits on HEAD since `sinceMs`, by the tickets they cite.
 * @param {number} sinceMs
 * @returns {Map<number, string[]>}
 */
function commitsByTicket(sinceMs) {
	const raw = execGit(
		["log", `--since=${new Date(sinceMs).toISOString()}`, LOG_FORMAT, "HEAD"],
		{ encoding: "utf8", maxBuffer: 64e6 },
	);
	/** @type {Map<number, string[]>} */
	const by = new Map();
	for (const record of String(raw).split("\x1e")) {
		const [sha, message = ""] = record.split("\x1f");
		if (!sha?.trim()) continue;
		for (const n of citedIssues(message))
			by.set(n, [...(by.get(n) ?? []), sha.trim()]);
	}
	return by;
}

/**
 * Whether `text` cites ticket `n`, by number or by a prefix of one of its
 * commits' shas.
 * @param {string} text
 * @param {number} n
 * @param {Map<number, string[]>} commits
 */
function cites(text, n, commits) {
	if (citedIssues(text).has(n)) return true;
	const shas = commits.get(n) ?? [];
	return [...text.matchAll(SHA_PREFIX_RE)].some((m) =>
		shas.some((s) => s.startsWith(m[0])),
	);
}

/** @param {SubIssue} s */
const isClosedTicket = (s) =>
	s.state === "closed" &&
	Boolean(s.closed_at) &&
	(s.labels ?? []).some((l) => l.name === "kind:ticket");

/**
 * Each ticket's follow-up share, keyed by issue number.
 * @param {Map<number, SubIssue[]>} subsBySpec
 * @param {Map<number, string[]>} commits
 */
function attribute(subsBySpec, commits) {
	/** @type {Map<number, number>} */
	const share = new Map();
	for (const subs of subsBySpec.values()) {
		/** @type {Candidate[]} */
		const tickets = subs.filter(isClosedTicket).map((s) => ({
			number: s.number,
			closedAt: Date.parse(/** @type {string} */ (s.closed_at)),
		}));
		for (const f of subs) {
			const filed = Date.parse(f.created_at);
			const before = tickets.filter(
				(t) => t.number !== f.number && t.closedAt < filed,
			);
			if (before.length === 0) continue;
			const cited = before.filter((t) =>
				cites(f.body ?? "", t.number, commits),
			);
			const to = cited.length > 0 ? cited : before;
			for (const t of to)
				share.set(t.number, (share.get(t.number) ?? 0) + 1 / to.length);
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
		const since = now() - days * DAY_MS;
		/**
		 * `any[]`: each endpoint decides its row, as lib/gh.js's ghApiSlurp says.
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
			compactions: sumCompactions(
				read([`repos/{owner}/{repo}/issues/${i.number}/comments?per_page=100`]),
			),
		}));
		const specs = [
			...new Set(units.map((u) => u.spec).filter((s) => s !== null)),
		];
		/** @type {Map<number, SubIssue[]>} */
		const subsBySpec = new Map(
			specs.map((s) => [
				/** @type {number} */ (s),
				read([`repos/{owner}/{repo}/issues/${s}/sub_issues?per_page=100`]),
			]),
		);
		const earliest = Math.min(
			since,
			...[...subsBySpec.values()].flat().map((s) => Date.parse(s.created_at)),
		);
		/** @type {Map<number, string[]>} */
		let commits;
		try {
			commits = commitsByTicket(earliest);
		} catch (e) {
			return ctx.skip(`git log would not answer (${caught(e).message}).`);
		}
		const bins = binUnits(units, attribute(subsBySpec, commits));
		const unlogged = units.filter((u) => u.compactions === null).length;

		ctx.say(
			`Build units closed in the last ${days} day(s), by autocompactions (the backstop is ${COMPACTION_BACKSTOP}):\n`,
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
