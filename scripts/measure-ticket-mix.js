#!/usr/bin/env node
/*
 * measure-ticket-mix.js — the counting half of retro-sweep's weekly ticket-mix
 * review (spec workflow-core#4796 §Ticket-mix review, workflow-core#4797). The model assigns titles to
 * kinds; this script does every count, limit and trigger.
 *
 * IN NO §N3 FAMILY: it gates nothing, writes no file and files no issue (the
 * retro files the candidates).
 *
 * INPUT. One tracker snapshot per repo (`--issues <owner/name>=<file>`, the
 * array `gh issue list --json number,title,body,state,closedAt,labels,createdAt`
 * writes, the retro's step-2 snapshot); the week (`--week-start`,
 * `--week-end`: an issue counts where `start <= createdAt < end`); the run
 * record (`--runs`, docs/data/retro-runs.jsonl) and the kept list of kinds
 * (`--kinds`, docs/data/ticket-kinds.json: `[{id, meaning, firstSeen}]`).
 *
 * TWO USES.
 *   Count (no `--assigned`): the week's total; per-origin counts, from the
 *   `origin:*` label or, without one, lib/origin-fallback.js's keyword rules,
 *   with how many took each route; title templates, Drain-style masked
 *   (MASKS); each kept kind's prior weekly counts and control limit; the
 *   prior weekly totals and whether this week's total moved sharply.
 *   Triggers (`--assigned <file>`, `{"<owner/name>#<n>": "<kind id>"}` from
 *   the model's batch assignment, after it appended any new kind to the kept
 *   list): everything above, plus each kind's count, share and triggers, the
 *   candidates, the watch kinds and the run line's `kinds` object.
 *
 * POINTS. A kind's prior points are the run record's weekly lines that carry
 * `kinds` and whose `week.start` is before this week's, in week order: a kind
 * missing from such a line is 0 there; a line without `kinds` is no point.
 * The totals' points are those lines' `ticketMixStep.total`.
 *
 * LIMITS (CONSTANTS). Under XMR_FROM points, the c-chart: mean ± 3 × √mean.
 * From XMR_FROM points on, XmR: mean ± 2.66 × the mean moving range. A share
 * is a proportion, so under XMR_FROM points its limit is the p-chart's,
 * p̄ ± 3 × √(p̄(1 − p̄) / n) with n this week's total, p̄ the prior shares'
 * mean; from XMR_FROM points on, XmR over the shares. No points, no limit.
 *
 * TRIGGERS, each held unless the kind has FLOOR or more tickets this week:
 *   new-kind    the kind's `firstSeen`, the UTC date of the run that added
 *               it, is after the week's start date: added this week, this
 *               run included. Dates are compared, never instants, so a run
 *               late in its UTC day still counts the kind it adds;
 *   over-limit  its count is over its upper limit, or, where this week's
 *               total moved sharply (outside the totals' own limits either
 *               way), its share is over its share's upper limit;
 *   trend       its last TREND_POINTS weekly points, this week the last, each
 *               rise on the one before (Nelson's rule 3, rising side). Under TREND_POINTS
 *               points its direction is `watch-only`, never a trigger;
 *   level       the Pareto level: kinds ranked by count, those that reach
 *               PARETO_SHARE of the week's total, at most PARETO_MAX, steady
 *               or not.
 * A kind is a candidate on any trigger. A watch kind is one whose trigger
 * the floor held, or one at the floor whose direction is still `watch-only`.
 *
 * FLIP. `flip.due` once the run record holds FLIP_RUNS weekly lines that
 * carry `ticketMixStep`, this run counted where `--this-run` is given (pass
 * it before the run line is appended, never after). The retro searches the
 * tracker for an existing flip check before filing one, its body naming
 * `flip.bar`.
 *
 * Exit 0 done; 1 a file will not read, an issue has no `createdAt`, or an
 * assignment names a kind off the kept list, each named on stderr and never
 * counted as zero; 1 also where a run line will not parse or carries counts
 * with no readable week, each named on stderr after the report, which counts
 * without it; 2 a command line lib/cli-args.js or the week refuses.
 */

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args");
const { errMessage } = require("./lib/check");
const { worktreeRoot } = require("./lib/host-root");
const { readJsonl } = require("./lib/jsonl.js");
const { requiredGroup } = require("./lib/regex-group");
const { asObject } = require("./lib/json-shape");
const { RUN_RECORD } = require("./lib/retro-record");
const { originOfLabels } = require("./lib/issue-origin");
const { classifyOrigin } = require("./lib/origin-fallback");
const { writeFd } = require("./lib/write-fd.js");

const CONSTANTS = /** @type {const} */ ({
	/* Spec workflow-core#4796: every trigger waits for 10 tickets of the kind in a week. */
	FLOOR: 10,
	SIGMAS: 3,
	/* XmR's 3 / d2 (d2 = 1.128 for a moving range of 2). */
	XMR_FACTOR: 2.66,
	/* Spec: XmR replaces the c-chart once 20–25 weekly points exist. */
	XMR_FROM: 20,
	/* Spec: a trend of 6 weeks running. */
	TREND_POINTS: 6,
	/* The Pareto level trigger's cut: Pareto analysis's 80/20 convention, the
	 * few kinds that make up 80% of the whole (Juran's "vital few"). */
	PARETO_SHARE: 0.8,
	/* A guess, and stated as one: no source sets how many steady kinds the
	 * level trigger names. */
	PARETO_MAX: 3,
	/* Spec: the flip check after 4 weekly runs with the step. */
	FLIP_RUNS: 4,
	/* Templates the human-readable output lists; --json lists all. A guess,
	 * and stated as one: a screenful, never measured against a week's spread. */
	TEMPLATES_SHOWN: 30,
});

const DEFAULT_KINDS = "docs/data/ticket-kinds.json";
/** The flip check's bar: the review drops to on-demand where it holds
 * (workflow-core#4796 §Ticket-mix review). */
const DROP_BAR =
	"fewer than 2 of the tickets it filed closed with a landed commit";

/* Drain-style masks, applied in this order: refs and branches before paths,
 * which would take their `/`; shas before numbers, which would take their
 * digits. Backticks are dropped first. */
const MASKS = /** @type {const} */ ([
	[/\b[\w.-]+\/[\w.-]+#\d+\b|#\d+\b/g, "<issue>"],
	[/\b(?:refs|q)\/[^\s`'"()<>,;]+|\bimplement-[\w.-]+/g, "<branch>"],
	[
		/(?<![^\s`'"()<>,;])[^\s`'"()<>,;]*\/[^\s`'"()<>,;]*[^\s`'"()<>,;:.]|\b[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5}\b/g,
		"<path>",
	],
	[/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, "<sha>"],
	[/\d+(?:[.,]\d+)*/g, "<n>"],
]);

const USAGE = `usage: node ${scriptPath("measure-ticket-mix.js")} --issues <owner/name>=<file> [--issues ...]
    --week-start <iso> --week-end <iso> [--runs <file>] [--kinds <file>]
    [--assigned <file>] [--this-run] [--json]
  --issues      one repo's tracker snapshot (gh issue list --json ...,createdAt); repeat per repo
  --week-start  first instant of the week; --week-end the instant after its last
  --runs        the run record (default ${RUN_RECORD})
  --kinds       the kept list of kinds (default ${DEFAULT_KINDS})
  --assigned    the model's assignment {"<owner/name>#<n>": "<kind id>"}: adds the triggers
  --this-run    count this run toward the flip check
  --json        print the report as JSON`;

/**
 * @typedef {import("./lib/origin-fallback").Label} Label
 * @typedef {{ number: number, title?: string, body?: string | null,
 *   labels?: Label[], createdAt?: string }} Issue
 * @typedef {{ id: string, meaning?: string, firstSeen?: string }} Kind
 * @typedef {{ start: number, kinds: Record<string, {count?: number, share?: number}> | null,
 *   total: number | null }} RunPoint
 * @typedef {{ points: number, mean: number | null, upper: number | null,
 *   lower: number | null, method: "none" | "c-chart" | "p-chart" | "xmr" }} Limits
 */

class ReadFailure extends Error {}

/**
 * @param {string} file
 * @param {string} what
 * @returns {unknown}
 */
function readJson(file, what) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		throw new ReadFailure(`${what} ${file} will not read: ${errMessage(e)}`, {
			cause: e,
		});
	}
}

/**
 * @param {number[]} xs
 * @returns {number}
 */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Each point less the one before it.
 * @param {number[]} xs
 * @returns {number[]}
 */
function successiveDiffs(xs) {
	/** @type {number[]} */
	const out = [];
	/** @type {number | undefined} */
	let prev;
	for (const x of xs) {
		if (prev !== undefined) out.push(x - prev);
		prev = x;
	}
	return out;
}

/**
 * @param {number[]} xs
 */
const meanMovingRange = (xs) => mean(successiveDiffs(xs).map(Math.abs));

/**
 * @param {number} m
 * @param {number} spread
 * @param {Limits["method"]} method
 * @param {number} points
 * @returns {Limits}
 */
const band = (m, spread, method, points) => ({
	points,
	mean: m,
	upper: m + spread,
	lower: Math.max(0, m - spread),
	method,
});

/** @param {number} points @returns {Limits} */
const noLimits = (points) => ({
	points,
	mean: null,
	upper: null,
	lower: null,
	method: "none",
});

/**
 * @param {number[]} xs
 * @returns {Limits}
 */
function countLimits(xs) {
	if (xs.length === 0) return noLimits(0);
	const m = mean(xs);
	return xs.length < CONSTANTS.XMR_FROM
		? band(m, CONSTANTS.SIGMAS * Math.sqrt(m), "c-chart", xs.length)
		: band(m, CONSTANTS.XMR_FACTOR * meanMovingRange(xs), "xmr", xs.length);
}

/**
 * @param {number[]} xs
 * @param {number} total
 * @returns {Limits}
 */
function shareLimits(xs, total) {
	if (xs.length === 0 || total === 0) return noLimits(xs.length);
	const m = mean(xs);
	return xs.length < CONSTANTS.XMR_FROM
		? band(
				m,
				CONSTANTS.SIGMAS * Math.sqrt((m * (1 - m)) / total),
				"p-chart",
				xs.length,
			)
		: band(m, CONSTANTS.XMR_FACTOR * meanMovingRange(xs), "xmr", xs.length);
}

/**
 * @param {string} title
 */
function template(title) {
	/* Code quoting is no part of a template. */
	let t = title.replaceAll("`", "");
	for (const [re, token] of MASKS) t = t.replace(re, token);
	return t.replace(/\s+/g, " ").trim();
}

/** @param {number} x */
const round = (x) => Math.round(x * 10_000) / 10_000;

/** @param {string} s */
const isoMs = (s) =>
	/^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s) : Number.NaN;

/**
 * Each `--issues` snapshot, as the week's issues with their refs.
 * @param {Snapshot[]} snapshots
 * @param {{start: number, end: number}} week
 * @returns {{ref: string, repo: string, issue: Issue}[]}
 */
function readWeek(snapshots, week) {
	/** @type {{ref: string, repo: string, issue: Issue}[]} */
	const out = [];
	for (const { repo, file } of snapshots) {
		const data = readJson(file, `the ${repo} snapshot`);
		if (!Array.isArray(data))
			throw new ReadFailure(
				`the ${repo} snapshot ${file} is not a JSON array of issues`,
			);
		const issues = /** @type {Issue[]} */ (data);
		const undated = issues.filter(
			(i) =>
				typeof i.createdAt !== "string" || Number.isNaN(isoMs(i.createdAt)),
		);
		if (undated.length > 0)
			throw new ReadFailure(
				`the ${repo} snapshot ${file} has ${undated.length} issue(s) with no readable createdAt (first #${undated[0]?.number}); re-take it with createdAt in --json`,
			);
		for (const issue of issues) {
			const at = isoMs(/** @type {string} */ (issue.createdAt));
			if (at >= week.start && at < week.end)
				out.push({ ref: `${repo}#${issue.number}`, repo, issue });
		}
	}
	return out;
}

/**
 * The run record's weekly lines before this week, in week order, how many
 * weekly lines carry the step, and each line read as nothing, named.
 * @param {string} file
 * @param {number} weekStart
 * @returns {{prior: RunPoint[], stepRuns: number, bad: string[]}}
 */
function readRuns(file, weekStart) {
	let log;
	try {
		log = readJsonl(file);
	} catch (e) {
		throw new ReadFailure(
			`the run record ${file} will not read: ${errMessage(e)}`,
			{ cause: e },
		);
	}
	if (log === null)
		throw new ReadFailure(`the run record ${file} will not read: absent`);
	const where = (/** @type {number} */ n) => `the run record ${file} line ${n}`;
	const bad = log.bad.map((n) => `${where(n)} will not parse`);
	/** @type {RunPoint[]} */
	const prior = [];
	let stepRuns = 0;
	for (const { row, line } of log.entries) {
		const read = readRunLine(row);
		if (read === "no week") {
			bad.push(
				`${where(line)} carries ticket-mix counts but no readable week.start`,
			);
			continue;
		}
		if (!read) continue;
		if (read.step) stepRuns += 1;
		if (read.point && read.point.start < weekStart) prior.push(read.point);
	}
	prior.sort((a, b) => a.start - b.start);
	return { prior, stepRuns, bad };
}

/**
 * One run line: whether it is a weekly line carrying the step, and its
 * ticket-mix point where it has one; null for a non-weekly line, "no week"
 * for counts with no readable `week.start`.
 * @param {Record<string, unknown>} line
 * @returns {{step: boolean, point: RunPoint | null} | null | "no week"}
 */
function readRunLine(line) {
	if (line.mode !== "weekly") return null;
	const step = asObject(line.ticketMixStep);
	const kinds = parsePointKinds(line.kinds);
	const total = typeof step?.total === "number" ? step.total : null;
	if (!kinds && total === null) return { step: Boolean(step), point: null };
	const start = isoMs(String(asObject(line.week)?.start ?? ""));
	if (Number.isNaN(start)) return "no week";
	return { step: Boolean(step), point: { start, kinds, total } };
}

/** @param {unknown} v @returns {number | undefined} */
const numberOr = (v) => (typeof v === "number" ? v : undefined);

/**
 * A run line's `kinds`, each kind's count and share kept where it is a
 * number; null where the line carries none.
 * @param {unknown} v
 * @returns {RunPoint["kinds"]}
 */
function parsePointKinds(v) {
	const kinds = asObject(v);
	if (!kinds) return null;
	return Object.fromEntries(
		Object.entries(kinds).map(([id, k]) => {
			const row = asObject(k);
			return [id, { count: numberOr(row?.count), share: numberOr(row?.share) }];
		}),
	);
}

/**
 * @param {string} file
 * @returns {Kind[]}
 */
function readKinds(file) {
	const data = readJson(file, "the kept list of kinds");
	if (
		!Array.isArray(data) ||
		data.some((k) => typeof k?.id !== "string" || !k.id)
	)
		throw new ReadFailure(
			`the kept list of kinds ${file} is not an array of {id, meaning, firstSeen}`,
		);
	return /** @type {Kind[]} */ (data);
}

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readAssigned(file) {
	const data = readJson(file, "the assignment");
	if (
		!data ||
		typeof data !== "object" ||
		Array.isArray(data) ||
		Object.values(data).some((v) => typeof v !== "string")
	)
		throw new ReadFailure(
			`the assignment ${file} is not an object of "<owner/name>#<n>": "<kind id>"`,
		);
	return /** @type {Record<string, string>} */ (data);
}

/**
 * Per-origin counts and the route each took.
 * @param {{issue: Issue}[]} week
 */
function countOrigins(week) {
	/** @type {Map<string, {origin: string, count: number, label: number, fallback: number}>} */
	const by = new Map();
	for (const { issue } of week) {
		const names = (issue.labels ?? []).map((l) =>
			typeof l === "string" ? l : l.name,
		);
		const labelled = originOfLabels(names);
		const origin = labelled ?? classifyOrigin(issue);
		const row = by.get(origin) ?? { origin, count: 0, label: 0, fallback: 0 };
		row.count += 1;
		if (labelled) row.label += 1;
		else row.fallback += 1;
		by.set(origin, row);
	}
	return [...by.values()].sort(
		(a, b) => b.count - a.count || a.origin.localeCompare(b.origin),
	);
}

/**
 * @param {{issue: Issue}[]} week
 */
function countTemplates(week) {
	/** @type {Map<string, number>} */
	const by = new Map();
	for (const { issue } of week) {
		const t = template(issue.title ?? "");
		by.set(t, (by.get(t) ?? 0) + 1);
	}
	return [...by.entries()]
		.map(([t, count]) => ({ template: t, count }))
		.sort((a, b) => b.count - a.count || a.template.localeCompare(b.template));
}

/**
 * @param {number[]} series prior points then this week
 * @returns {"watch-only" | "up" | "down" | "none"}
 */
function direction(series) {
	if (series.length < CONSTANTS.TREND_POINTS) return "watch-only";
	const steps = successiveDiffs(series.slice(-CONSTANTS.TREND_POINTS));
	if (steps.every((d) => d > 0)) return "up";
	if (steps.every((d) => d < 0)) return "down";
	return "none";
}

/**
 * @typedef {{ start: number, end: number, startIso: string, endIso: string }} Week
 * @typedef {{ repo: string, file: string }} Snapshot  one `--issues`
 * @typedef {{ issues: Snapshot[], week: Week, runs: string, kinds: string,
 *   assigned: string | null, thisRun: boolean }} Options
 */

/**
 * @param {Options} o
 */
function buildReport(o) {
	const week = readWeek(o.issues, o.week);
	const { prior, stepRuns, bad } = readRuns(o.runs, o.week.start);
	const kinds = readKinds(o.kinds);
	const assigned = o.assigned === null ? null : readAssigned(o.assigned);
	const total = week.length;

	const totalPoints = prior.flatMap((p) => (p.total === null ? [] : [p.total]));
	const totalLimits = countLimits(totalPoints);
	const sharp =
		totalLimits.upper !== null &&
		totalLimits.lower !== null &&
		(total > totalLimits.upper || total < totalLimits.lower);

	const kindLines = prior.filter((p) => p.kinds !== null);
	const kindRows = kinds.map((k) => {
		const points = kindLines.map((p) => p.kinds?.[k.id]?.count ?? 0);
		const shares = kindLines.map((p) => p.kinds?.[k.id]?.share ?? 0);
		return {
			id: k.id,
			meaning: k.meaning ?? "",
			firstSeen: k.firstSeen ?? null,
			points,
			limits: countLimits(points),
			shares,
			shareLimits: shareLimits(shares, total),
		};
	});

	const runs = stepRuns + (o.thisRun ? 1 : 0);
	const report = {
		week: { start: o.week.startIso, end: o.week.endIso },
		total,
		repos: Object.fromEntries(
			o.issues.map(({ repo }) => [
				repo,
				week.filter((w) => w.repo === repo).length,
			]),
		),
		origins: countOrigins(week),
		templates: countTemplates(week),
		totals: { points: totalPoints, limits: totalLimits, sharp },
		kinds: kindRows.map(({ id, meaning, firstSeen, points, limits }) => ({
			id,
			meaning,
			firstSeen,
			points,
			limits,
		})),
		flip: { runs, due: runs >= CONSTANTS.FLIP_RUNS, bar: DROP_BAR },
		badRunLines: bad,
		/** @type {ReturnType<typeof buildTriggers> | null} */
		triggers: null,
	};
	if (assigned)
		report.triggers = buildTriggers({
			assigned,
			week,
			kindRows,
			kinds,
			total,
			sharp,
			window: o.week,
			file: /** @type {string} */ (o.assigned),
		});
	return report;
}

/**
 * @param {{ assigned: Record<string, string>, week: {ref: string}[],
 *   kindRows: {id: string, points: number[], limits: Limits, shareLimits: Limits}[],
 *   kinds: Kind[], total: number, sharp: boolean, window: Week, file: string }} a
 */
function buildTriggers({
	assigned,
	week,
	kindRows,
	kinds,
	total,
	sharp,
	window,
	file,
}) {
	const known = new Set(kinds.map((k) => k.id));
	const off = [...new Set(Object.values(assigned))].filter(
		(id) => !known.has(id),
	);
	if (off.length > 0)
		throw new ReadFailure(
			`the assignment ${file} names kind(s) off the kept list: ${off.join(", ")}; append them to the kept list first`,
		);
	const inWeek = new Set(week.map((w) => w.ref));
	/** @type {Map<string, string[]>} */
	const refsOf = new Map();
	for (const [ref, id] of Object.entries(assigned))
		if (inWeek.has(ref)) refsOf.set(id, [...(refsOf.get(id) ?? []), ref]);
	const unassigned = week
		.map((w) => w.ref)
		.filter((r) => !Object.hasOwn(assigned, r));
	const notThisWeek = Object.keys(assigned).filter((r) => !inWeek.has(r));

	const counted = kindRows.map((k) => {
		const refs = refsOf.get(k.id) ?? [];
		return { ...k, refs, count: refs.length };
	});
	const level = new Set();
	let cum = 0;
	for (const k of [...counted].sort(
		(a, b) => b.count - a.count || a.id.localeCompare(b.id),
	)) {
		if (
			k.count > 0 &&
			cum < CONSTANTS.PARETO_SHARE * total &&
			level.size < CONSTANTS.PARETO_MAX
		)
			level.add(k.id);
		cum += k.count;
	}
	const firstSeenOf = new Map(kinds.map((k) => [k.id, k.firstSeen ?? null]));

	const rows = counted.map((k) =>
		buildKindRow(k, {
			total,
			sharp,
			window,
			level: level.has(k.id),
			firstSeen: firstSeenOf.get(k.id) ?? null,
		}),
	);
	const candidates = rows
		.filter((r) => r.triggers.length > 0)
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
		.map(({ id, count, share, triggers, refs }) => ({
			kind: id,
			count,
			share,
			triggers,
			refs,
		}));
	const watch = rows
		.filter(
			(r) =>
				r.held.length > 0 ||
				(r.triggers.length === 0 &&
					r.count >= CONSTANTS.FLOOR &&
					r.direction === "watch-only"),
		)
		.map((r) => r.id);
	return {
		kinds: rows,
		candidates,
		watch,
		unassigned,
		notThisWeek,
		runLine: {
			kinds: Object.fromEntries(
				rows
					.filter((r) => r.count > 0)
					.map((r) => [r.id, { count: r.count, share: r.share }]),
			),
			total,
			watch,
		},
	};
}

/**
 * Whether a kind's `firstSeen` date is after the week's start date.
 * @param {string | null} firstSeen  YYYY-MM-DD
 * @param {Week} window
 */
function isNewKind(firstSeen, window) {
	const date = /^\d{4}-\d{2}-\d{2}/.exec(firstSeen ?? "")?.[0];
	return (
		date !== undefined &&
		date > new Date(window.start).toISOString().slice(0, 10)
	);
}

/**
 * @param {{id: string, points: number[], limits: Limits, shareLimits: Limits,
 *   refs: string[], count: number}} k
 * @param {{total: number, sharp: boolean, window: Week, level: boolean,
 *   firstSeen: string | null}} at
 */
function buildKindRow(k, { total, sharp, window, level, firstSeen }) {
	const share = total === 0 ? 0 : k.count / total;
	const dir = direction([...k.points, k.count]);
	const overCount = k.limits.upper !== null && k.count > k.limits.upper;
	const overShare =
		sharp && k.shareLimits.upper !== null && share > k.shareLimits.upper;
	const would = /** @type {[string, boolean][]} */ ([
		["new-kind", isNewKind(firstSeen, window)],
		["over-limit", overCount || overShare],
		["trend", dir === "up"],
		["level", level],
	])
		.filter(([, fires]) => fires)
		.map(([name]) => name);
	const atFloor = k.count >= CONSTANTS.FLOOR;
	return {
		id: k.id,
		count: k.count,
		share: round(share),
		limit: k.limits.upper === null ? null : round(k.limits.upper),
		method: k.limits.method,
		shareLimit:
			k.shareLimits.upper === null ? null : round(k.shareLimits.upper),
		shareCompared: sharp,
		over: { count: overCount, share: overShare },
		direction: dir,
		triggers: atFloor ? would : [],
		held: atFloor ? [] : would,
		refs: k.refs,
	};
}

/** @param {number | null} x */
const fig = (x) => (x === null ? "none" : String(round(x)));

/**
 * @param {ReturnType<typeof buildReport>} r
 * @returns {string}
 */
function render(r) {
	const out = [
		`Ticket mix, ${r.week.start} to ${r.week.end}: ${r.total} issue(s) (${Object.entries(
			r.repos,
		)
			.map(([repo, n]) => `${repo} ${n}`)
			.join(", ")}).`,
		`Totals: prior [${r.totals.points.join(", ")}], ${r.totals.limits.method} limits ${fig(r.totals.limits.lower)}–${fig(r.totals.limits.upper)}; ${r.totals.sharp ? "MOVED SHARPLY — shares compared as well as counts" : "steady"}.`,
		"",
		"Origins (count: label + fallback):",
		...r.origins.map(
			(o) => `  ${o.origin}: ${o.count} (${o.label} + ${o.fallback})`,
		),
		"",
		`Templates (top ${CONSTANTS.TEMPLATES_SHOWN} of ${r.templates.length}):`,
		...r.templates
			.slice(0, CONSTANTS.TEMPLATES_SHOWN)
			.map((tp) => `  ${tp.count}  ${tp.template}`),
		"",
		"Kept kinds (prior points; mean; limit):",
		...r.kinds.map(
			(k) =>
				`  ${k.id}: [${k.points.join(", ")}]; ${fig(k.limits.mean)}; ${fig(k.limits.upper)} (${k.limits.method})`,
		),
	];
	const t = r.triggers;
	if (t) {
		out.push(
			"",
			`Kinds this week (floor ${CONSTANTS.FLOOR}):`,
			...t.kinds
				.filter((k) => k.count > 0)
				.map(
					(k) =>
						`  ${k.id}: ${k.count} (${(k.share * 100).toFixed(1)}%), limit ${fig(k.limit)}${k.shareCompared ? `, share limit ${k.shareLimit === null ? "none" : `${(k.shareLimit * 100).toFixed(1)}%`}` : ""}, direction ${k.direction}${k.triggers.length > 0 ? `; TRIGGERS ${k.triggers.join(", ")}` : ""}${k.held.length > 0 ? `; held under the floor: ${k.held.join(", ")}` : ""}`,
				),
			"",
			"Candidates:",
			...(t.candidates.length > 0
				? t.candidates.map(
						(c) =>
							`  ${c.kind}: ${c.count} (${(c.share * 100).toFixed(1)}%) — ${c.triggers.join(", ")} — ${c.refs.join(" ")}`,
					)
				: ["  none"]),
			`Watch: ${t.watch.length > 0 ? t.watch.join(", ") : "none"}`,
		);
		if (t.unassigned.length > 0)
			out.push(
				`UNASSIGNED: ${t.unassigned.length} issue(s) of the week have no kind: ${t.unassigned.join(" ")}`,
			);
		if (t.notThisWeek.length > 0)
			out.push(
				`NOT THIS WEEK: ${t.notThisWeek.length} assigned ref(s) are not in the week's snapshots: ${t.notThisWeek.join(" ")}`,
			);
		out.push(`Run line kinds: ${JSON.stringify(t.runLine.kinds)}`);
	}
	out.push(
		"",
		`Flip check: ${r.flip.runs} of ${CONSTANTS.FLIP_RUNS} weekly runs with the step — ${r.flip.due ? "DUE" : "not due"}; drops to on-demand if ${r.flip.bar}.`,
	);
	return `${out.join("\n")}\n`;
}

/**
 * Each `--issues <owner/name>=<file>`, or the first that is not one.
 * @param {string[]} specs
 * @returns {Snapshot[] | string}
 */
function parseSnapshots(specs) {
	/** @type {Snapshot[]} */
	const out = [];
	const re = /^([^/=\s]+\/[^/=\s]+)=(.+)$/;
	for (const spec of specs) {
		const m = re.exec(spec);
		if (!m) return spec;
		out.push({
			repo: requiredGroup(m, 1, re),
			file: path.resolve(requiredGroup(m, 2, re)),
		});
	}
	return out;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: {
			"--issues": "list",
			"--week-start": "value",
			"--week-end": "value",
			"--runs": "value",
			"--kinds": "value",
			"--assigned": "value",
			"--this-run": "boolean",
			"--json": "boolean",
		},
	});
	if (typeof parsed === "number") return parsed;
	/** @param {string} msg */
	const usage = (msg) => {
		writeFd(2, `${msg}\n\n${USAGE}\n`);
		return 2;
	};
	const specs = parsed.lists["--issues"] ?? [];
	if (specs.length === 0) return usage("--issues is required");
	const issues = parseSnapshots(specs);
	if (typeof issues === "string")
		return usage(`--issues takes <owner/name>=<file>, not ${issues}`);
	const startIso = parsed.flags["--week-start"];
	const endIso = parsed.flags["--week-end"];
	if (typeof startIso !== "string" || typeof endIso !== "string")
		return usage("--week-start and --week-end are required");
	const start = isoMs(startIso);
	const end = isoMs(endIso);
	if (Number.isNaN(start) || Number.isNaN(end) || end <= start)
		return usage(
			`the week ${startIso} to ${endIso} is not two ISO instants, start first`,
		);
	/** @param {string} flag @param {string} fallback */
	const file = (flag, fallback) => {
		const v = parsed.flags[flag];
		return typeof v === "string"
			? path.resolve(v)
			: path.join(worktreeRoot(), fallback);
	};
	const assigned = parsed.flags["--assigned"];
	let report;
	try {
		report = buildReport({
			issues,
			week: { start, end, startIso, endIso },
			runs: file("--runs", RUN_RECORD),
			kinds: file("--kinds", DEFAULT_KINDS),
			assigned: typeof assigned === "string" ? path.resolve(assigned) : null,
			thisRun: parsed.flags["--this-run"] === true,
		});
	} catch (e) {
		if (!(e instanceof ReadFailure)) throw e;
		writeFd(2, `measure-ticket-mix: ${e.message}\n`);
		return 1;
	}
	writeFd(
		1,
		parsed.flags["--json"]
			? `${JSON.stringify(report, null, 2)}\n`
			: render(report),
	);
	if (report.badRunLines.length === 0) return 0;
	writeFd(
		2,
		report.badRunLines.map((b) => `measure-ticket-mix: ${b}\n`).join(""),
	);
	return 1;
}

module.exports = { main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
